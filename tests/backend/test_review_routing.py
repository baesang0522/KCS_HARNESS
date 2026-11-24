import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage

from agents.request_graph import run_request_graph
from agents.review_target import check_review_tool, ReviewTargetError
from repositories.conversation_repository import MemoryConversation
from services.documents.schemas import ReferenceDocument
from services.investigation.schemas import Condition, SupplierTarget
from services.investigation.service import investigation_context
from services.operations.rules import preprocess
from services.operations.schemas import Rule

RULES = [dict(operation='uppercase'), dict(operation='remove_words', words=['CO.,', 'CO.', 'LTD.', 'LTD', 'PTE.', 'PTE']), dict(operation='trim')]
REQUESTS = [
    '추출된 회사명을 전부 대문자로 바꿔주고, CO., LTD, PTE등 회사축약어를 삭제해줘. 그리고 좌우 공백 없애줘',
    '아니 거래처검토 시트의 회사명을 저렇게 작업해달라고',
    '아니 거래처검토 시트의 전부 대문자로 바꿔주고, CO., LTD, PTE등 회사축약어를 삭제해줘. 그리고 좌우 공백 없애달라고',
    '아니 거래처검토 시트의 회사명을 전부 대문자로 바꿔주고, CO., LTD, PTE등 회사축약어를 삭제해줘. 그리고 좌우 공백 없애달라고',
]


def context():
    conversation = MemoryConversation();did = str(uuid4())
    conversation.documents[did] = ReferenceDocument(document_id=did, filename='해외거래처.pdf',
        pages=[dict(page_number=1, text='회사 목록', readable=True)])
    conversation.investigation.document_notes[did] = []
    conversation.investigation.conditions = [Condition(title='회사', description='회사', source_document_id=did,
        source_pages=[1], target=SupplierTarget(kind='supplier', group='1', category='회사', company_name=f'Company {i}')) for i in range(16)]
    workspace = dict(workspace_id=str(uuid4()), task_type='investigation', row_count=3036,
        sheet_name='조사_원본', columns=[dict(column_id='company',header='해외거래처상호',role='company_name')],
        target_column_ids=['company'])
    return dict(workspace=workspace, investigation=investigation_context(conversation, workspace)), did


class ReviewRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_reported_request_corrects_wrong_workspace_tool_before_execution(self):
        for request in REQUESTS:
            for wrong in ['preprocess', 'start_task']:
                with self.subTest(request=request, wrong=wrong):
                    ctx, did = context();ctx['user_request'] = request
                    replies = [AIMessage(content='', tool_calls=[dict(name=wrong,
                        args=dict(column_id='company', rules=RULES) if wrong=='preprocess' else dict(task_type='counterparty_cleanup'), id='wrong')]),
                        AIMessage(content='', tool_calls=[dict(name='review_document', args=dict(document_id=did,
                            action='preprocess', kind='supplier', column='회사명', rules=RULES), id='correct')])]
                    model = SimpleNamespace(ainvoke=AsyncMock(side_effect=replies))
                    runtime = SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a, **k:model), tools_prompt='test')
                    with patch('builtins.print') as logged:
                        result = await run_request_graph(runtime, [HumanMessage(content=request)], ctx)
                    events = [json.loads(call.args[0]) for call in logged.call_args_list]
                    self.assertEqual([e['tool_name'] for e in events if e['event']=='tool.completed'], ['review_document'])
                    self.assertEqual(result['intent'], 'document')
                    self.assertEqual(result['document_action']['document_id'], did)
                    self.assertEqual(result['document_action']['column'], '회사명')
                    self.assertEqual([r['operation'] for r in result['document_action']['rules']], ['uppercase','remove_words','trim'])
                    self.assertEqual(ctx['investigation']['review_targets'][0]['saved_row_count'],16)
                    self.assertNotIn('operation', result)

    async def test_repeated_wrong_tool_does_not_emit_workspace_action(self):
        ctx, _ = context();ctx['user_request']=REQUESTS[-1]
        model=SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content='',tool_calls=[dict(name='preprocess',args=dict(column_id='company',rules=RULES),id=str(i))]) for i in range(2)]))
        runtime=SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a,**k:model),tools_prompt='test')
        with patch('builtins.print'):
            result=await run_request_graph(runtime,[HumanMessage(content=REQUESTS[-1])],ctx)
        self.assertEqual(result['intent'],'clarify')
        self.assertIn('작업표에는 실행하지 않았습니다',result['answer'])

    def test_workspace_requests_and_reference_formulas_remain_available(self):
        ctx,_=context()
        for request in ['작업표 해외거래처상호를 대문자로 바꿔줘',
                        '거래처검토 시트를 참고해서 작업표 해외거래처상호를 정제해줘']:
            ctx['user_request']=request
            check_review_tool(ctx,'preprocess')
        ctx['user_request']='거래처검토 시트를 참조해서 회사명 일치 여부를 수식으로 계산해줘'
        check_review_tool(ctx,'start_task',dict(task_type='formula'))
        ctx['user_request']='작업표 말고 거래처검토 시트 회사명을 대문자로 바꿔줘'
        with self.assertRaises(ReviewTargetError):check_review_tool(ctx,'preprocess')

    def test_missing_document_does_not_fall_back_to_workspace(self):
        ctx,_=context();ctx['investigation']={};ctx['user_request']=REQUESTS[-1]
        with self.assertRaisesRegex(ReviewTargetError,'찾지 못했어요'):check_review_tool(ctx,'preprocess')
        ctx['user_request']=REQUESTS[0]
        check_review_tool(ctx,'preprocess')  # Without a PDF reference, an extracted workspace column is still valid.

    def test_common_rules_preserve_company_words_and_requested_order(self):
        rules=[Rule(**r) for r in RULES]
        self.assertEqual(preprocess('  Baoshan Iron & Steel Co., Ltd.  ',rules),'BAOSHAN IRON & STEEL')
        self.assertEqual(preprocess('  Shagang International (Singapore) Pte. Ltd.  ',rules),'SHAGANG INTERNATIONAL (SINGAPORE)')
        self.assertEqual(preprocess('COAST INTERNATIONAL STEEL',rules),'COAST INTERNATIONAL STEEL')

    def test_exact_review_sheet_name_is_not_substituted_with_another_document(self):
        ctx,did=context();target=ctx['investigation']['review_targets'][0]
        target['sheet_name']='내 거래처 목록'
        ctx['investigation']['review_targets'].append({**target,'document_id':str(uuid4()),'sheet_name':'다른 거래처 목록'})
        ctx['user_request']='내 거래처 목록의 회사명을 대문자로 바꿔줘'
        with self.assertRaises(ReviewTargetError):check_review_tool(ctx,'preprocess')
        with self.assertRaisesRegex(ReviewTargetError,'문서가 다릅니다'):
            check_review_tool(ctx,'review_document',dict(document_id=ctx['investigation']['review_targets'][1]['document_id']))
        check_review_tool(ctx,'review_document',dict(document_id=did))

    async def test_named_workspace_column_corrects_pdf_preprocessing_despite_previous_pdf_request(self):
        request = '해외거래처상호에서 CO, LTD, PTE등 회사를 나타내는 축약어를 전부 제거해줘'
        rules = [dict(operation='remove_words', words=['CO.,', 'CO.', 'CO', 'LTD.', 'LTD', 'PTE.', 'PTE'])]
        for tool in ['preprocess', 'remove_words']:
            with self.subTest(tool=tool):
                ctx, did = context(); ctx['user_request'] = request
                ctx['investigation']['review_targets'][0]['sheet_name'] = '대상공급자'
                wrong = dict(name='review_document', args=dict(document_id=did, action='preprocess',
                    kind='supplier', column='회사명', rules=rules), id='wrong-pdf')
                args = dict(column_id='company', rules=rules) if tool == 'preprocess' else dict(column_id='company', words=rules[0]['words'])
                model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content='', tool_calls=[wrong]),
                    AIMessage(content='', tool_calls=[dict(name=tool, args=args, id='correct-workspace')])]))
                runtime = SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a, **k:model), tools_prompt='test')
                history = [HumanMessage(content='대상공급자 시트의 회사명을 정제해줘'),
                           AIMessage(content='PDF 검토 작업을 준비할게요.'), HumanMessage(content=request)]
                with patch('builtins.print') as logged:
                    result = await run_request_graph(runtime, history, ctx)
                events = [json.loads(call.args[0]) for call in logged.call_args_list]
                self.assertEqual([e['tool_name'] for e in events if e['event']=='tool.completed'], [tool])
                self.assertEqual(result['intent'], 'operation')
                self.assertEqual(result['operation']['column_ids'], ['company'])
                self.assertEqual(result['operation']['rules'][0]['words'], rules[0]['words'])
                self.assertNotIn('document_action', result)
                correction = model.ainvoke.call_args_list[1].args[0][-1].content
                self.assertIn('해외거래처상호', correction)
                self.assertIn('column_id=company', correction)

    async def test_repeated_wrong_pdf_tool_never_requests_document_name_for_clear_workspace_request(self):
        ctx, did = context(); ctx['user_request'] = '해외거래처상호에서 CO, LTD, PTE를 제거해줘'
        ctx['investigation']['review_targets'][0]['sheet_name'] = '대상공급자'
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content='', tool_calls=[dict(
            name='review_document', args=dict(document_id=did, action='preprocess', rules=RULES), id=str(i))]) for i in range(2)]))
        runtime = SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a, **k:model), tools_prompt='test')
        with patch('builtins.print') as logged:
            result = await run_request_graph(runtime, [HumanMessage(content=ctx['user_request'])], ctx)
        events = [json.loads(call.args[0]) for call in logged.call_args_list]
        self.assertFalse(any(e['event']=='tool.completed' for e in events))
        self.assertEqual(result['intent'], 'clarify')
        self.assertIn('요청한 작업표 열', result['answer'])
        self.assertNotIn('문서 이름', result['answer'])
        self.assertNotIn('document_action', result)

    def test_explicit_review_targets_and_non_preprocessing_actions_are_not_blocked(self):
        ctx, did = context();ctx['investigation']['review_targets'][0]['sheet_name'] = '대상공급자'
        args = dict(document_id=did, action='preprocess')
        for request in ['대상공급자 시트에서 해외거래처상호 열을 정제해줘',
                        'PDF 검토 시트의 해외거래처상호 열을 정제해줘',
                        '해외거래처.pdf의 해외거래처상호를 정제해줘', REQUESTS[0]]:
            with self.subTest(request=request):
                ctx['user_request'] = request
                check_review_tool(ctx, 'review_document', args)
        ctx['user_request'] = '해외거래처상호를 정제해줘'
        for action in ['apply', 'retry']:
            check_review_tool(ctx, 'review_document', dict(document_id=did, action=action))
        ctx['agent_execution'] = True
        check_review_tool(ctx, 'review_document', args)

    def test_explicit_workspace_header_needs_no_workspace_keyword_and_handles_spacing(self):
        ctx, did = context();ctx['investigation']['review_targets'][0]['sheet_name'] = '대상공급자'
        ctx['user_request'] = '해외 거래처 상호에서 회사 약어 지워줘'
        with self.assertRaisesRegex(ReviewTargetError, 'column_id=company'):
            check_review_tool(ctx, 'review_document', dict(document_id=did, action='preprocess'))
        check_review_tool(ctx, 'preprocess')
        ctx['user_request'] = '회사명을 정제해줘'
        check_review_tool(ctx, 'review_document', dict(document_id=did, action='preprocess'))
