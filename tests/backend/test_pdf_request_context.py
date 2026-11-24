import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from langchain_core.messages import AIMessage, ToolMessage

from agents.request_graph import run_request_graph
from agents.tools.pdf_lookup import build_pdf_lookup_tools
from repositories.conversation_repository import MemoryConversationRepository, to_messages
from services.chat.service import process_chat
from services.agent_runs.service import advance
from services.agent_runs.schemas import Advance
from services.documents.schemas import ReferenceDocument, DocumentWorkspace
from services.formula.schemas import CreateFormulaJobRequest
from services.formula.service import create_formula_job
from services.investigation.bindings import condition_version
from services.investigation.model_context import history_summary, model_task_context
from services.investigation.schemas import Condition
from services.investigation.service import investigation_context


RAW = 'RAW_PDF_PAGE_ONLY_원본근거'
QUOTE = 'EVIDENCE_QUOTE_ONLY_인용문'
REVIEWED = 'REVIEWED_SHEET_ONLY_수정된회사명'
NOTES = 'DOCUMENT_NOTES_ONLY_추출메모'


class PdfRequestContextTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repo = MemoryConversationRepository()
        self.cid = await self.repo.create()
        self.conv = self.repo._conversations[self.cid]
        self.did = str(uuid4())
        self.workspace = dict(workspace_id=str(uuid4()), worksheet_id='sheet', table_id='table',
            task_type='investigation', sheet_name='조사', row_start=1, row_count=3,
            columns=[dict(column_id='name', header='회사명', role='company_name'),
                     dict(column_id='group', header='그룹', role='result')], target_column_ids=['name'])
        self.conv.investigation.workspace = DocumentWorkspace.model_validate({key: self.workspace[key]
            for key in DocumentWorkspace.model_fields})
        self.conv.documents[self.did] = ReferenceDocument(document_id=self.did, filename='업무.pdf', pages=[
            dict(page_number=1, text=RAW, readable=True), dict(page_number=2, text='SECOND_PAGE', readable=True)])
        self.condition = Condition(target=dict(kind='supplier', group='1', category='수정 그룹', company_name=REVIEWED),
            source_document_id=self.did, source_pages=[1], title='회사 조건', description='옛 추출 설명',
            status='confirmed', edited=True, evidence=[dict(document_id=self.did, filename='업무.pdf', page_number=1, quote=QUOTE)])
        self.conv.investigation.conditions = [self.condition]
        self.conv.investigation.document_notes[self.did] = [NOTES]
        self.requests, self.queue, self.tool_names = [], [], []
        owner = self
        class Model:
            def bind_tools(self, tools, **kwargs):
                self.names = {item.name for item in tools}
                return self
            async def ainvoke(self, messages):
                owner.requests.append(copy.deepcopy(messages))
                owner.tool_names.append(self.names.copy())
                name, args = owner.queue.pop(0)
                assert name in self.names, name
                return AIMessage(content='', tool_calls=[dict(name=name, args=args, id=str(uuid4()))])
        self.runtime = SimpleNamespace(model=Model(), tools_prompt='test',
                                       settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=120)))

    async def chat(self, message, *calls):
        self.queue.extend(calls)
        with patch('builtins.print'):
            return await process_chat(runtime=self.runtime, repository=self.repo, formula_jobs={}, operation_jobs={},
                conversation_id=self.cid, request_id=str(uuid4()), message=message, workspace=self.workspace)

    def content(self, messages):
        return '\n'.join(str(item.content) for item in messages)

    def context(self, message='PDF 조건으로 선별해줘'):
        return {'workspace': self.workspace, 'user_request': message,
                'investigation': investigation_context(self.conv, self.workspace)}

    async def test_extract_other_work_source_other_work_does_not_replay_pdf(self):
        # 추출·수정 반영 상태는 setUp에 보관돼 있다. 2번 일반 작업.
        await self.chat('회사명 공백 정리해줘', ('preprocess', {'column_id': 'name', 'rules': [{'operation': 'trim'}]}))
        for marker in [RAW, QUOTE, REVIEWED, NOTES]:
            self.assertNotIn(marker, self.content(self.requests[-1]))
        overview = json.loads(self.requests[-1][1].content)['task_context']['investigation']
        self.assertEqual(overview['condition_status_counts'], {'confirmed': 1})
        self.assertTrue(overview['documents'][0]['extracted'])

        # 3번 원문 질문: 이 요청의 도구 응답에만 본문을 싣는다.
        first_source_call = len(self.requests)
        result = await self.chat('업무.pdf 1페이지 원문 뭐임?',
            ('read_pdf_source', {'document_id': self.did, 'pages': [1]}),
            ('answer_question', {'answer': '1페이지: ' + RAW}))
        self.assertNotIn(RAW, self.content(self.requests[first_source_call]))
        self.assertIn(RAW, self.content(self.requests[-1]))
        self.assertNotIn('SECOND_PAGE', self.content(self.requests[-1]))
        self.assertIn(RAW, result['answer'])
        self.assertIn(RAW, to_messages(self.conv.turns)[-1]['content'])

        # 4번 다른 작업: 원문 답변/질문을 대화 이력에서도 위치 기록으로 치환.
        await self.chat('회사명 열 역할을 바꿔줘', ('set_column_role', {'column_id': 'name', 'role': 'reference'}))
        content = self.content(self.requests[-1])
        for marker in [RAW, QUOTE, REVIEWED, NOTES]:
            self.assertNotIn(marker, content)
        self.assertIn('pdf_source', content)
        self.assertIn(self.did, content)
        self.assertEqual(self.conv.documents[self.did].pages[0].text, RAW)

        # 수식 생성의 최근 대화 경로에도 원문 답변을 전달하지 않는다.
        source = CreateFormulaJobRequest(task_type='formula', conversation_id=self.cid, formula_job_id=uuid4(),
            instruction='상수 1 계산', worksheet_id='sheet', sheet_name='조사', address='A2:A4',
            row_start=1, column_start=0, row_count=3, column_count=1, samples=[{'cells': ['A']}])
        jobs = {}
        await create_formula_job(source, self.repo, jobs)
        history = jobs[str(source.formula_job_id)].planning_context.model_dump_json()
        self.assertNotIn(RAW, history)
        self.assertIn('pdf_source', history)

    async def test_review_lookup_then_scope_uses_reviewed_values_and_original_version(self):
        key = str(self.condition.condition_id)
        reply = await self.chat('PDF 조건에 맞는 행만 골라줘',
            ('read_review_conditions', {'document_id': self.did, 'kind': 'supplier'}),
            ('change_scope', {'mode': 'replace', 'column_id': 'name', 'value': REVIEWED,
                              'condition_ids': [key], 'note': '회사명 열과 검토한 회사명 정확 일치'}))
        tool_result = json.loads(next(item.content for item in self.requests[-1] if isinstance(item, ToolMessage)))
        self.assertEqual(tool_result['conditions'][0]['target']['company_name'], REVIEWED)
        self.assertTrue(tool_result['conditions'][0]['edited'])
        self.assertNotIn(QUOTE, self.content(self.requests[-1]))
        self.assertNotIn(RAW, self.content(self.requests[-1]))
        self.assertEqual(reply['ui_action']['request']['condition_versions'][key], condition_version(self.condition))
        self.assertEqual(reply['ui_action']['request']['condition']['value'], REVIEWED)
        await self.chat('다른 작업 안내해줘', ('answer_question', {'answer': '다음 작업을 알려줘'}))
        self.assertNotIn(REVIEWED, self.content(self.requests[-1]))

    async def test_matching_does_not_require_lookup_or_expose_reference_list(self):
        result = await self.chat('회사명 유사도 80점으로 매칭해줘',
            ('match_suppliers', {'column_id': 'name', 'threshold': 80}))
        self.assertEqual(result['ui_action']['operation']['similarity_threshold'], 80)
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn(REVIEWED, self.content(self.requests[0]))

    def test_projection_does_not_change_saved_conditions_or_job_references(self):
        context = self.context()
        context['agent_run'] = {'observation': {'kind': 'operation', 'result': {
            'supplier_references': [{'company_name': REVIEWED}], 'model_references': [{'model': 'PDF_MODEL'}],
            'status': 'APPLIED', 'result_column_ids': ['group']}}}
        original = copy.deepcopy(context)
        projected = model_task_context(context)
        self.assertNotIn(REVIEWED, json.dumps(projected, ensure_ascii=False))
        self.assertNotIn(QUOTE, json.dumps(projected, ensure_ascii=False))
        self.assertEqual(projected['agent_run']['observation']['result']['supplier_references_count'], 1)
        self.assertEqual(context, original)

    def test_default_context_size_does_not_grow_with_pdf_quotes_or_condition_rows(self):
        context = self.context()
        item = context['investigation']['conditions'][0]
        context['investigation']['conditions'] = [item] * 1000
        original_chars = len(json.dumps(context, ensure_ascii=False))
        projected = model_task_context(context)
        self.assertEqual(projected['investigation']['condition_count'], 1000)
        self.assertLess(len(json.dumps(projected, ensure_ascii=False)), original_chars // 10)
        self.assertEqual(len(context['investigation']['conditions']), 1000)
        tools = {tool.name: tool for tool in build_pdf_lookup_tools(context)}
        result = tools['read_review_conditions'].invoke({})
        self.assertEqual(len(result['conditions']), 1000)
        self.assertLess(len(history_summary(context)), 500)

    async def test_agent_source_answer_is_not_reinjected_into_next_chat(self):
        reply = await self.chat('업무.pdf 원문 설명해줘',
            ('start_agent', {'goal': '업무.pdf 원문 설명'}))
        self.queue.extend([('read_pdf_source', {'document_id': self.did, 'pages': [1]}),
                           ('answer_question', {'answer': RAW})])
        with patch('builtins.print'):
            result = await advance(conversation=self.conv, conversation_id=self.cid,
                run_id=reply['ui_action']['run_id'], payload=Advance(request_id=uuid4(), workspace=self.workspace),
                runtime=self.runtime, operation_jobs={}, formula_jobs={})
        self.assertEqual(result['status'], 'COMPLETED')
        self.assertEqual(result['answer'], RAW)
        self.assertIn(RAW, self.content(self.requests[-1]))
        await self.chat('이전 목표 계속해줘', ('resume_agent', {}))
        await self.chat('회사명 열 역할 바꿔줘', ('set_column_role', {'column_id': 'name', 'role': 'reference'}))
        self.assertNotIn(RAW, self.content(self.requests[-1]))
        self.assertNotIn(QUOTE, self.content(self.requests[-1]))
        self.assertIn('pdf_source', self.content(self.requests[-1]))

    def test_lookup_rejects_wrong_documents_and_pages_without_silent_truncation(self):
        context = self.context('원문 보여줘')
        tools = {tool.name: tool for tool in build_pdf_lookup_tools(context, self.conv.documents)}
        source = tools['read_pdf_source']
        with self.assertRaises(ValueError):
            source.invoke({'document_id': str(uuid4())})
        with self.assertRaises(ValueError):
            source.invoke({'document_id': self.did, 'pages': [3]})
        result = source.invoke({'document_id': self.did})
        self.assertEqual([page['page_number'] for page in result['pages']], [1, 2])
        self.assertEqual(result['pages'][0]['text'], RAW)
        other = self.context()
        other['investigation'] = {'scope': 'different_workspace'}
        self.assertEqual(build_pdf_lookup_tools(other, self.conv.documents), [])
        self.assertNotIn('read_pdf_source', {tool.name for tool in build_pdf_lookup_tools(self.context(), {})})

    async def test_pending_review_is_not_treated_as_confirmed(self):
        self.condition.status = 'candidate'
        key = str(self.condition.condition_id)
        result = await self.chat('PDF 조건으로 선별해줘',
            ('read_review_conditions', {'kind': 'supplier'}),
            ('change_scope', {'mode': 'replace', 'column_id': 'name', 'value': REVIEWED,
                              'condition_ids': [key], 'note': '일치'}),
            ('ask_user', {'question': '검토 내용을 반영해 주세요.'}))
        self.assertIsNone(result['ui_action'])
        self.assertIn('반영', result['answer'])
