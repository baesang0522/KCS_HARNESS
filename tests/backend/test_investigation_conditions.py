import asyncio
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from agents.request_router import RequestDecision
from agents.request_tools import build_request_tools
from api.chat import router as chat_router
from api.documents import router as documents_router
from api.errors import request_validation_response, service_error_response
from api.investigation import router
from repositories.conversation_repository import ConversationNotFound, MemoryConversationRepository, StoredTurn
from services.documents.schemas import ReferenceDocument
from services.errors import ServiceError
from services.investigation import evidence_sources, investigation_context


def make_app():
    app = FastAPI()
    app.include_router(router)
    app.include_router(documents_router)
    app.include_router(chat_router)
    app.add_exception_handler(ServiceError, service_error_response)
    app.add_exception_handler(ConversationNotFound, service_error_response)
    app.add_exception_handler(RequestValidationError, request_validation_response)
    app.state.conversations = MemoryConversationRepository()
    app.state.formula_jobs = {}
    app.state.operation_jobs = {}
    app.state.document_slots = asyncio.Semaphore(2)
    return app


class InvestigationConditionTests(unittest.TestCase):
    def setUp(self):
        self.app = make_app()
        self.client = TestClient(self.app)
        self.cid = self.client.post('/conversations').json()['conversation_id']
        self.base = f'/conversations/{self.cid}/investigation'
        self.conversation = self.app.state.conversations._conversations[self.cid]
        self.did = str(uuid4())
        self.conversation.documents[self.did] = ReferenceDocument(
            document_id=self.did, filename='품목.pdf', pages=[dict(page_number=1, readable=True,
                text='제외되는 물품. HS 7208.51.1000 또는 7208.51.9000.\nSA516-70(두께 134밀리미터 이상)\nSA302-Grade C')])
        self.output = {'conditions': [dict(title='SA516-70',
            description='HS 7208511000 또는 7208519000이며 SA516-70이고 두께 134mm 이상인 품목',
            evidence=[dict(page_number=1, source_id=1),
                      dict(page_number=1, source_id=2)]),
            dict(title='SA302-Grade C', description='HS 7208511000 또는 7208519000이며 SA302-Grade C인 품목. 두께 조건 명시 없음.',
                 evidence=[dict(page_number=1, source_id=3)])], 'warnings': []}
        for index, condition in enumerate(self.output['conditions']):
            condition['target'] = dict(kind='item', group=str(index + 1), hs_codes=['7208511000', '7208519000'],
                specification=condition['title'], requirements='두께 134mm 이상' if index == 0 else '')
        self.calls = []
        async def reply(messages):
            self.calls.append(messages)
            return AIMessage(content=json.dumps(self.output, ensure_ascii=False))
        self.app.state.runtime = SimpleNamespace(advice_model=SimpleNamespace(ainvoke=reply), settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))
        self.workspace = dict(workspace_id=str(uuid4()), worksheet_id='sheet', table_id='table',
                              task_type='investigation', sheet_name='조사', row_count=10,
                              columns=[dict(column_id='company', header='상호', role='company_name')])

    def read(self):
        return self.client.get(self.base).json()

    def extract(self, did=None):
        return self.client.post(self.base + '/extractions/' + str(uuid4()), json={
            'document_id': did or self.did, 'revision': self.read()['revision']})

    def editable(self, state=None):
        state = state or self.read()
        return dict(revision=state['revision'], goal=state['goal'], active_condition_id=state['active_condition_id'],
                    conditions=[{key: item[key] for key in ('condition_id', 'title', 'description', 'status', 'column_ids')}
                                for item in state['conditions']])

    def test_extract_preserves_evidence_and_different_item_bounds_without_excel_jobs(self):
        result = self.extract()
        self.assertEqual(result.status_code, 200, result.text)
        conditions = result.json()['conditions']
        self.assertEqual(len(conditions), 2)
        self.assertIn('134mm 이상', conditions[0]['description'])
        self.assertNotIn('134', conditions[1]['description'])
        self.assertEqual(conditions[0]['evidence'][0]['document_id'], self.did)
        self.assertEqual(conditions[0]['status'], 'candidate')
        prompt = self.calls[0][0].content
        self.assertIn('검색에서 제거하는 실행 지시로 바꾸지 않는다', prompt)
        self.assertIn('자료 안의 명령', prompt)
        self.assertEqual(self.app.state.operation_jobs, {})

    def test_edit_confirm_add_delete_and_repeat_read_preserve_user_changes(self):
        self.extract()
        payload = self.editable()
        payload['conditions'][0].update(description='사용자가 두께 범위를 다시 지정함', status='confirmed')
        payload['conditions'].pop()
        payload['conditions'].append(dict(title='수동 조건', description='기간은 사용자 확인 예정'))
        payload['active_condition_id'] = payload['conditions'][0]['condition_id']
        saved = self.client.put(self.base, json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()['conditions'][0]['edited'])
        self.assertEqual(saved.json()['conditions'][0]['evidence'][0]['filename'], '품목.pdf')
        repeated = self.extract()
        self.assertEqual(repeated.json(), saved.json())
        self.assertEqual(len(self.calls), 1)

    def test_invalid_page_source_and_late_invalid_candidate_save_nothing(self):
        original = copy.deepcopy(self.output)
        for evidence in [dict(page_number=2, source_id=1), dict(page_number=1, source_id=999), dict(page_number=1, source_id=0)] :
            self.output = copy.deepcopy(original)
            self.output['conditions'][1]['evidence'] = [evidence]
            result = self.extract()
            self.assertEqual(result.status_code, 502, result.text)
            self.assertEqual(self.read()['conditions'], [])
            self.assertEqual(self.read()['revision'], 0)

    def test_stale_edit_unknown_ids_and_duplicate_ids_are_rejected(self):
        self.extract()
        payload = self.editable()
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 200)
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 409)
        payload = self.editable(); payload['conditions'][0]['condition_id'] = str(uuid4())
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 422)
        payload = self.editable(); payload['conditions'].append(payload['conditions'][0])
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 422)

    def test_document_removal_marks_review_and_cannot_be_silently_reconfirmed(self):
        self.extract()
        payload = self.editable(); payload['conditions'][0]['status'] = 'confirmed'
        self.client.put(self.base, json=payload)
        self.client.delete(f'/conversations/{self.cid}/documents/{self.did}')
        self.assertEqual(self.read()['conditions'][0]['status'], 'needs_review')
        payload = self.editable(); payload['conditions'][0]['status'] = 'confirmed'
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 409)
        replacement = str(uuid4())
        self.conversation.documents[replacement] = self.conversation.documents.get(self.did) or ReferenceDocument(
            document_id=replacement, filename='품목.pdf', pages=[dict(page_number=1, readable=True, text='새 문서')])
        self.assertEqual(self.read()['conditions'][0]['evidence'][0]['document_id'], self.did)

    def test_workspace_binding_deleted_columns_and_explicit_switch(self):
        self.extract()
        link = {'task_type': 'investigation', 'workspace': {key: value for key, value in self.workspace.items()
                  if key not in ('columns', 'row_count')}}
        self.client.put(f'/conversations/{self.cid}/documents/{self.did}/link', json=link)
        payload = self.editable(); payload.update(workspace=self.workspace, bind_workspace=True)
        payload['conditions'][0].update(status='confirmed', column_ids=['company'])
        result = self.client.put(self.base, json=payload)
        self.assertEqual(result.status_code, 200, result.text)
        other = {**self.workspace, 'workspace_id': str(uuid4())}
        self.assertEqual(investigation_context(self.conversation, other)['scope'], 'different_workspace')
        self.assertNotIn('conditions', investigation_context(self.conversation, other))
        renamed = {**self.workspace, 'columns': [dict(column_id='company', header='바꾼 이름', role='company_name')]}
        self.assertEqual(investigation_context(self.conversation, renamed)['conditions'][0]['status'], 'confirmed')
        deleted = {**self.workspace, 'columns': []}
        self.assertEqual(investigation_context(self.conversation, deleted)['conditions'][0]['status'], 'needs_review')
        payload = self.editable(); payload['workspace'] = other
        self.assertEqual(self.client.put(self.base, json=payload).status_code, 409)
        payload['bind_workspace'] = True
        switched = self.client.put(self.base, json=payload)
        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()['conditions'][0]['column_ids'], [])
        self.assertEqual(switched.json()['conditions'][0]['status'], 'needs_review')

    def test_linking_document_to_another_workspace_marks_review(self):
        self.extract()
        link = {'task_type': 'investigation', 'workspace': {key: value for key, value in self.workspace.items()
                  if key not in ('columns', 'row_count')}}
        result = self.client.put(f'/conversations/{self.cid}/documents/{self.did}/link', json=link)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.read()['conditions'][0]['status'], 'needs_review')

    def test_conditions_survive_ten_turn_window_and_other_conversation_is_empty(self):
        self.extract()
        for index in range(12):
            self.conversation.turns.append(StoredTurn(request_id=str(uuid4()), question=f'질문{index}', answer='답', reasoning=[]))
        captured = {}
        async def route(runtime, messages, *, task_context):
            captured.update(context=task_context, messages=messages)
            return RequestDecision(intent='general', answer='기억한 조건'), []
        with patch('services.chat.route_request', new=route):
            result = self.client.post('/chat', json=dict(conversation_id=self.cid, request_id=str(uuid4()), message='조사 조건이 뭐였지?'))
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(captured['messages']), 21)
        self.assertEqual(len(captured['context']['investigation']['conditions']), 2)
        other = self.client.post('/conversations').json()['conversation_id']
        self.assertEqual(self.client.get(f'/conversations/{other}/investigation').json()['conditions'], [])
        result = self.client.post(f'/conversations/{other}/investigation/extractions/{uuid4()}', json=dict(document_id=self.did, revision=0))
        self.assertEqual(result.status_code, 404)

    def test_invalid_model_output_does_not_create_partial_conditions(self):
        self.conversation.documents[self.did].pages[0].text = '조건'
        self.app.state.runtime.advice_model.ainvoke = AsyncMock(return_value=AIMessage(content='잘못된 JSON'))
        self.assertEqual(self.extract().status_code, 502)
        self.assertEqual(self.read()['conditions'], [])

    def test_chat_condition_request_returns_valid_ui_action(self):
        async def route(runtime, messages, *, task_context):
            return RequestDecision(intent='investigation', answer='조건 화면'), []
        with patch('services.chat.route_request', new=route):
            result = self.client.post('/chat', json=dict(conversation_id=self.cid, request_id=str(uuid4()), message='PDF 조사 조건 보여줘'))
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['ui_action'], {'type': 'open_investigation'})

    def test_no_conditions_warning_is_stored_and_ui_tool_only_opens_panel(self):
        self.output = dict(conditions=[], warnings=['목록 하단이 잘려 이후 조건은 확인할 수 없음'])
        result = self.extract()
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json()['document_notes'][self.did])
        tool = next(item for item in build_request_tools({}) if item.name == 'open_investigation')
        self.assertEqual(tool.invoke({})['intent'], 'investigation')

    def save_rows(self, rows, expected=None):
        state = self.read()
        return self.client.put(self.base + '/reviews/' + self.did, json=dict(
            revision=state['revision'], expected_rows=expected if expected is not None else state['reviews'][self.did], rows=rows))

    def test_review_reorder_edits_delete_and_add_preserve_original_evidence(self):
        self.extract()
        original = copy.deepcopy(self.read()['reviews'][self.did])
        rows = list(reversed(copy.deepcopy(original)))
        rows[1]['target']['requirements'] = '두께 150mm 이상'
        rows.append(dict(target=dict(kind='supplier', group='새 그룹', category='관계 수출사', company_name='사용자 회사'), source_pages=[]))
        result = self.save_rows(rows)
        self.assertEqual(result.status_code, 200, result.text)
        conditions = result.json()['conditions']
        self.assertEqual(conditions[0]['target']['specification'], 'SA302-Grade C')
        self.assertFalse(conditions[0]['edited'])
        self.assertTrue(conditions[0]['evidence'])
        self.assertTrue(conditions[1]['edited'])
        self.assertEqual(conditions[1]['evidence'], [])
        self.assertIn('150mm', conditions[1]['description'])
        self.assertNotIn('134mm', conditions[1]['description'])
        self.assertEqual([c['status'] for c in conditions], ['confirmed'] * 3)
        self.assertEqual(self.conversation.investigation.extracted_conditions[self.did][0].target.requirements, '두께 134mm 이상')
        self.assertEqual(self.extract().json()['reviews'][self.did], result.json()['reviews'][self.did])
        result = self.save_rows([])
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['conditions'], [])
        self.assertEqual(self.extract().json()['reviews'][self.did], [])

    def test_supplier_groups_mixed_names_are_individual_rows_and_other_pdf_survives_apply(self):
        self.extract()
        item_id = self.did
        self.did = str(uuid4())
        self.conversation.documents[self.did] = ReferenceDocument(document_id=self.did, filename='해외.pdf',
            pages=[dict(page_number=1, readable=True, text='1. Baoshan Iron & Steel Co., Ltd. 관계 수출사: 한글 Export Co.')])
        self.output = dict(conditions=[dict(title=name, description=name,
            target=dict(kind='supplier', group='1', category=category, company_name=name),
            evidence=[dict(page_number=1, source_id=1)]) for name, category in [
                ('Baoshan Iron & Steel Co., Ltd.', '제조사'), ('한글 Export Co.', '관계 수출사')]], warnings=[])
        result = self.extract()
        self.assertEqual(result.status_code, 200, result.text)
        rows = result.json()['reviews'][self.did]
        self.assertEqual([r['target']['group'] for r in rows], ['1', '1'])
        rows.reverse(); rows[0]['target']['company_name'] = '사용자 수정 Export'
        result = self.save_rows(rows)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(result.json()['reviews'][item_id]), 2)
        ctx = investigation_context(self.conversation, None)
        self.assertEqual(ctx['conditions'][-2]['target']['company_name'], '사용자 수정 Export')
        self.assertEqual(ctx['conditions'][-2]['target']['category'], '관계 수출사')

    def test_bad_review_values_and_conflicts_do_not_partially_replace_conditions(self):
        self.extract()
        original = copy.deepcopy(self.read())
        for edit in ['page', 'blank', 'hs']:
            rows = copy.deepcopy(original['reviews'][self.did])
            if edit == 'page': rows[-1]['source_pages'] = [99]
            elif edit == 'blank': rows[-1]['target']['group'] = '  '
            else: rows[-1]['target']['hs_codes'] = ['=NOW()']
            result = self.save_rows(rows)
            self.assertEqual(result.status_code, 422, result.text)
            self.assertEqual(self.read(), original)
        rows = copy.deepcopy(original['reviews'][self.did])
        rows[0]['target']['requirements'] = '수정 조건'
        self.assertEqual(self.save_rows(rows).status_code, 200)
        result = self.save_rows([], expected=original['reviews'][self.did])
        self.assertEqual(result.status_code, 409, result.text)
        self.assertEqual(len(self.read()['conditions']), 2)
        self.client.delete(f'/conversations/{self.cid}/documents/{self.did}')
        self.assertEqual(self.save_rows([]).status_code, 404)

    def test_auto_binding_pending_and_future_uploads_uses_one_workspace(self):
        self.extract()
        workspace = {key: value for key, value in self.workspace.items() if key not in ('columns', 'row_count')}
        result = self.client.put(self.base + '/workspace', json=workspace)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['conditions'][0]['status'], 'candidate')
        self.assertEqual(self.conversation.documents[self.did].link.workspace.workspace_id, self.conversation.investigation.workspace.workspace_id)
        other = {**workspace, 'workspace_id': str(uuid4())}
        self.assertEqual(self.client.put(self.base + '/workspace', json=other).status_code, 409)
        renamed = {**workspace, 'sheet_name': '새 이름'}
        self.assertEqual(self.client.put(self.base + '/workspace', json=renamed).status_code, 200)
        with patch('api.documents.extract_in_process', new=AsyncMock(return_value=self.conversation.documents[self.did].pages)):
            uploaded = self.client.post(f'/conversations/{self.cid}/documents/{uuid4()}?filename=next.pdf', content=b'%PDF-1.7 test')
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertEqual(uploaded.json()['link']['workspace']['workspace_id'], workspace['workspace_id'])

    def test_model_must_supply_structured_targets_and_schema_failure_is_atomic(self):
        del self.output['conditions'][1]['target']
        result = self.extract()
        self.assertEqual(result.status_code, 502, result.text)
        self.assertEqual(self.read()['reviews'], {})
        self.assertEqual(self.conversation.investigation.extracted_conditions, {})

    def test_markdown_line_breaks_are_copied_from_server_sources_not_rewritten_by_model(self):
        raw = '|중국|안강 스틸(Angang Steel Co., Ltd.)<br>안강 홍콩(Angang\nGroup Hong Kong Co., Ltd.)|'
        self.conversation.documents[self.did].pages[0].text = raw
        self.output = dict(conditions=[dict(title='안강 홍콩', description='관계 수출사 Angang Group Hong Kong Co., Ltd.',
            target=dict(kind='supplier', group='4', category='관계 수출사', company_name='Angang Group Hong Kong Co., Ltd.'),
            evidence=[dict(page_number=1, source_id=1), dict(page_number=1, source_id=2)])], warnings=[])
        result = self.extract()
        self.assertEqual(result.status_code, 200, result.text)
        evidence = result.json()['conditions'][0]['evidence']
        self.assertEqual([e['quote'] for e in evidence], raw.splitlines())
        sent = json.loads(self.calls[0][1].content)
        self.assertEqual(sent['pages'][0]['sources'][0]['text'], raw.splitlines()[0])
        self.assertNotIn('quote', sent['response_schema']['$defs']['SourceReference']['properties'])
        self.assertEqual(result.json()['reviews'][self.did][0]['source_pages'], [1])

    def test_source_ids_are_page_local_and_long_lines_are_not_truncated(self):
        document = ReferenceDocument(document_id=self.did, filename='긴 표.pdf', pages=[
            dict(page_number=1, readable=True, text='A' * 2001),
            dict(page_number=2, readable=False, text='읽지 못한 내용'),
            dict(page_number=3, readable=True, text='다른 페이지')])
        pages, sources = evidence_sources(document)
        self.assertEqual([p['page_number'] for p in pages], [1, 3])
        self.assertEqual(sources[(1, 1)] + sources[(1, 2)], 'A' * 2001)
        self.assertEqual(sources[(3, 1)], '다른 페이지')
        self.assertNotIn((3, 2), sources)
        self.assertTrue(all(len(text) <= 2000 for text in sources.values()))
        self.conversation.documents[self.did] = document
        self.output['conditions'][1]['evidence'] = [dict(page_number=3, source_id=2)]
        self.assertEqual(self.extract().status_code, 502)
        self.assertEqual(self.read()['conditions'], [])


    def test_bilingual_supplier_names_are_split_only_on_initial_extraction(self):
        names=[('바오 스틸','Baoshan Iron & Steel Co., Ltd.'),('우한 스틸','Wuhan Iron & Steel Co., Ltd.'),
               ('메이산 스틸','Shanghai Meishan Iron & Steel Co., Ltd.'),('바오스틸 짠장','Baosteel Zhanjiang Iron & Steel Co., Ltd.'),
               ('산동 르자오','Shandong Iron And Steel Group Rizhao Co., Ltd.')]
        self.output={'conditions':[dict(title=ko,description='제조사 또는 관계회사 '+ko+'('+en+')',
            target=dict(kind='supplier',group='1',category='회사',company_name=ko+'('+en+')'),
            evidence=[dict(page_number=1,source_id=1)],uncertainty='') for ko,en in names],'warnings':[]}
        response=self.extract();self.assertEqual(response.status_code,200,response.text)
        rows=response.json()['reviews'][self.did]
        self.assertEqual([(row['target']['category'],row['target']['company_name']) for row in rows],names)
        changed=copy.deepcopy(rows);changed[0]['target']['category']='사용자 표기'
        saved=self.client.put(self.base+'/reviews/'+self.did,json=dict(revision=response.json()['revision'],expected_rows=rows,rows=changed))
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(self.extract().json()['reviews'][self.did][0]['target']['category'],'사용자 표기')

class InvestigationCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_extraction_preserves_document_and_existing_state(self):
        app = make_app()
        cid = await app.state.conversations.create()
        did, rid = str(uuid4()), str(uuid4())
        conversation = app.state.conversations._conversations[cid]
        conversation.documents[did] = ReferenceDocument(document_id=did, filename='test.pdf',
            pages=[dict(page_number=1, readable=True, text='기업 목록')])
        entered = asyncio.Event()
        async def reply(messages):
            entered.set(); await asyncio.Future()
        app.state.runtime = SimpleNamespace(advice_model=SimpleNamespace(ainvoke=reply), settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            pending = asyncio.create_task(client.post(f'/conversations/{cid}/investigation/extractions/{rid}', json=dict(document_id=did, revision=0)))
            await asyncio.wait_for(entered.wait(), 2)
            await client.post(f'/conversations/{cid}/requests/{rid}/cancel')
            self.assertEqual((await pending).status_code, 409)
        self.assertIn(did, conversation.documents)
        self.assertEqual(conversation.investigation.revision, 0)
        self.assertEqual(conversation.investigation.conditions, [])
