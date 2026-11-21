import unittest
import asyncio
import copy
import json
from unittest.mock import AsyncMock

from langchain_core.messages import HumanMessage
from agents.request_router import route_request
from models.codex_adapter import CodexModel
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.operation_jobs import router
from api.errors import service_error_response
from agents.request_tools import build_request_tools
from agents.execution_tools import execution_tools
from repositories.conversation_repository import MemoryConversation, MemoryConversationRepository
from services.documents.schemas import DocumentWorkspace
from services.errors import ServiceError
from services.investigation.schemas import Condition, ItemTarget
from services.model_matching import compare
from services.operations.jobs import operation_history_context
from services.operations.schemas import Row


class ModelMatchingTests(unittest.TestCase):
    def compare(self, values, refs):
        return [r.values for r in compare([Row(excel_row=i+2, values=[v]) for i,v in enumerate(values)], refs).rows]

    def test_exact_model_boundaries_normalization_and_no_label_fallback(self):
        refs = [dict(model='SM490', category='일반재'), dict(model='SM490A', category='PDF의 분류'),
                dict(model='SA516', category='일반재'), dict(model='SA516-70', category='열처리 강종'),
                dict(model='API 2W GR50', category='TMCP 강종')]
        self.assertEqual(self.compare(['PLATE sm490a 20MM', 'SM490AX XSM490A SM490A1',
            'GRADE: SA516-70', 'SA516-70N SA516-701 SA516.1', 'api  2w\nGR50',
            'MODEL: UNKNOWN', 'GR: UNKNOWN', ''], refs),
            [['SM490A','PDF의 분류'],['',''],['SA516-70','열처리 강종'],['',''],
             ['API 2W GR50','TMCP 강종'],['',''],['',''],['','']])

    def test_multiple_and_conflicting_categories_preserve_pairs_and_longest_name(self):
        refs=[dict(model='API', category='짧은 이름'),dict(model='API 2W GR50', category='TMCP'),
              dict(model='SM490A',category='일반재'),dict(model='SM490A',category='열처리'),
              dict(model='SM490A',category='일반재')]
        self.assertEqual(self.compare(['API 2W GR50; SM490A', 'API / API 2W GR50'],refs),
            [['API 2W GR50\nSM490A\nSM490A','TMCP\n일반재\n열처리'],['API\nAPI 2W GR50','짧은 이름\nTMCP']])
        self.assertEqual(self.compare(['AB1 AB1', 'AB1'],[dict(model='AB1',category='')]),[['AB1',''],['AB1','']])

    def test_literal_punctuation_aliases_and_duplicate_rows(self):
        refs=[dict(model='AR400(NM400)',category='열처리'),dict(model='AB.12',category='종류')]
        self.assertEqual(self.compare(['AR400(NM400)', 'NM400', 'AR400', 'ABX12', 'AB.12', 'AR400(NM400)'],refs),
            [['AR400(NM400)','열처리'],['',''],['',''],['',''],['AB.12','종류'],['AR400(NM400)','열처리']])

    def setUp(self):
        self.app=FastAPI();self.app.include_router(router);self.app.add_exception_handler(ServiceError,service_error_response)
        self.app.state.conversations=MemoryConversationRepository();self.app.state.operation_jobs={};self.app.state.formula_jobs={}
        self.cid=str(uuid4());self.conversation=MemoryConversation()
        self.app.state.conversations._conversations[self.cid]=self.conversation
        self.workspace=dict(workspace_id=str(uuid4()),worksheet_id='sheet',table_id='table',sheet_name='작업',task_type='investigation')
        self.conversation.investigation.workspace=DocumentWorkspace(**self.workspace)
        self.did=uuid4();self.conversation.documents[str(self.did)]=SimpleNamespace(link=None)
        self.conversation.investigation.conditions=[Condition(target=ItemTarget(kind='item',group='PDF 분류',
            specification='SA516-70',hs_codes=[],requirements='두께 134mm 이상'),title='모델',description='원문',
            status='confirmed',source_document_id=self.did,source_pages=[1])]
        self.source=dict(operation_job_id=str(uuid4()),conversation_id=self.cid,**{k:v for k,v in self.workspace.items() if k!='sheet_name'},
            row_start=1,row_count=10,model_spec_column_id='model',operation=dict(kind='extract',column_ids=['model'],extraction_mode='pdf'))
        self.client=TestClient(self.app)

    def url(self, action):
        return f"/operation-jobs/{self.source['operation_job_id']}/{action}?conversation_id={self.cid}"

    def create(self):
        response=self.client.post('/operation-jobs',json=self.source)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def test_api_uses_confirmed_pdf_and_both_outputs_are_data(self):
        job=self.create();self.assertEqual(job['model_references'][0]['category'],'PDF 분류')
        response=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['PLATE SA516-70 20MM']}], 'selected_count':2})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['rows'][0]['values'],['SA516-70','PDF 분류'])
        self.assertEqual(response.json()['headers'],['모델명','모델명 종류'])
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        response=self.client.post(self.url('apply'),json={'mode':'new','anchor':'model','name':'모델명'})
        self.assertEqual(response.status_code,200,response.text)
        response=self.client.post(self.url('status'),json={'status':'APPLIED','result_column_ids':['name','category']})
        self.assertEqual(response.status_code,200,response.text)
        context=operation_history_context(self.app.state.operation_jobs,conversation_id=self.cid,
            workspace={**self.workspace,'columns':[dict(column_id=c,header=c) for c in ['model','name','category']]})
        self.assertEqual([c['purpose'] for c in context['records'][0]['result_columns']],['data','data'])

    def test_changed_pdf_blocks_later_batch_and_apply(self):
        self.create();self.conversation.investigation.conditions[0].target.group='수정'
        response=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['SA516-70']}]})
        self.assertEqual(response.status_code,409,response.text)
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        response=self.client.post(self.url('apply'),json={'mode':'new','anchor':'model','name':'모델명'})
        self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(self.app.state.operation_jobs[self.source['operation_job_id']].status,'PREVIEW_READY')

    def test_missing_unconfirmed_cross_workspace_and_deleted_pdf_block_creation(self):
        condition=self.conversation.investigation.conditions[0]
        condition.status='candidate';self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        condition.status='confirmed';self.source['workspace_id']=str(uuid4())
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.source['workspace_id']=self.workspace['workspace_id'];self.conversation.documents.clear()
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.conversation.investigation.conditions=[]
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.assertEqual(self.app.state.operation_jobs,{})

    def test_existing_destination_cannot_silently_discard_category(self):
        self.source['operation']['output']=dict(mode='existing',column_id='model')
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,422)
        del self.source['operation']['output'];self.create()
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        response=self.client.post(self.url('apply'),json={'mode':'existing','column_id':'model'})
        self.assertEqual(response.status_code,409,response.text)

    def test_explicit_input_routes_to_extraction_and_previews_without_role_change(self):
        for role, registered in [('reference', None), ('result', 'other')]:
            with self.subTest(role=role):
                columns = [dict(column_id='model', header='모델규격명', role=role)]
                if registered:
                    columns.append(dict(column_id=registered, header='다른 규격', role='model_spec'))
                context = {'workspace': {**self.workspace, 'columns': columns, 'target_column_ids': ['model']}}
                before = copy.deepcopy(context)
                model = CodexModel('test')
                model._execute = AsyncMock(return_value=dict(name='find_model_candidates', arguments=json.dumps({
                    'column_id': 'model', 'extraction_mode': 'pdf', 'output': {'mode': 'new', 'name': '모델'}})))
                decision, _ = asyncio.run(route_request(SimpleNamespace(model=model, tools_prompt='test'),
                    [HumanMessage(content='품목검토시트의 규격을 모델규격명에서 추출해 새 모델 열과 옆 그룹 열에 적어줘')],
                    task_context=context))
                self.assertEqual(decision.intent, 'operation')
                self.assertIsNone(decision.workspace_action)
                self.assertEqual(model._execute.await_count, 1)
                self.assertEqual(context, before)
                self.source.update(operation_job_id=str(uuid4()), model_spec_column_id=registered,
                                   operation=decision.operation.model_dump())
                self.create()
                response = self.client.post(self.url('preview'), json={'rows': [
                    {'excel_row': 2, 'values': ['PLATE SA516-70']}, {'excel_row': 3, 'values': ['UNKNOWN']}],
                    'selected_count': 2})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([r['values'] for r in response.json()['rows']], [['SA516-70', 'PDF 분류'], ['', '']])

    def test_explicit_input_and_omitted_input_have_separate_validation(self):
        workspace = {**self.workspace, 'columns': [dict(column_id='chosen', header='규격 정제', role='reference')],
                     'target_column_ids': ['chosen']}
        tool = next(t for t in build_request_tools({'workspace': workspace}) if t.name == 'find_model_candidates')
        for mode in ['pdf', 'labelled', 'alphanumeric', None]:
            with self.subTest(mode=mode):
                result = tool.invoke({'column_id': 'chosen', 'extraction_mode': mode})
                self.assertEqual(result['operation']['column_ids'], ['chosen'])
        with self.assertRaisesRegex(ValueError, '현재 작업시트에 없는 열'):
            tool.invoke({'column_id': 'missing'})
        with self.assertRaisesRegex(ValueError, '모델규격명 열을 하나'):
            tool.invoke({})
        workspace['columns'] += [dict(column_id=c, header=c, role='model_spec') for c in ['a', 'b']]
        with self.assertRaisesRegex(ValueError, '모델규격명 열을 하나'):
            tool.invoke({})
        self.assertEqual(tool.invoke({'column_id': 'chosen'})['operation']['column_ids'], ['chosen'])

    def test_tool_defaults_to_pdf_and_explicit_patterns_remain_available(self):
        context={'workspace':{**self.workspace,'columns':[dict(column_id='model',header='모델규격명',role='model_spec')],'target_column_ids':['model']}}
        tools=build_request_tools(context);tool=next(t for t in tools if t.name=='find_model_candidates')
        self.assertEqual(tool.invoke({})['operation']['extraction_mode'],'pdf')
        self.assertEqual(tool.invoke({'extraction_mode':'labelled'})['operation']['extraction_mode'],'labelled')
        self.assertEqual(tool.invoke({'extraction_mode':'alphanumeric'})['operation']['extraction_mode'],'alphanumeric')
        self.assertIn('find_model_candidates',{t.name for t in execution_tools(context,tools)})
        with self.assertRaises(ValueError):tool.invoke({'column_id':'wrong'})

if __name__=='__main__': unittest.main()
