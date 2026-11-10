import copy
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from api.chat import router as chat_router
from api.formula_jobs import router as formula_router
from api.errors import service_error_response
from repositories.conversation_repository import MemoryConversationRepository, ConversationNotFound
from services.errors import ServiceError
from services.chat import build_task_context
from services.chat_state import WorkFlowState
from services.formula.schemas import CreateFormulaJobRequest, FormulaPlan
from services.operations.jobs import CreateOperationJob, OperationJob
from agents.request_tools import build_request_tools


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.repo = MemoryConversationRepository()
        app = FastAPI()
        app.include_router(chat_router)
        app.include_router(formula_router)
        app.add_exception_handler(ServiceError, service_error_response)
        app.add_exception_handler(ConversationNotFound, service_error_response)
        self.planning_inputs = []
        self.decision = {'intent': 'start_task', 'task_type': 'formula',
                         'formula_column_ids': ['trade', 'cleaned'], 'answer': '입력 열을 확인하세요.'}
        async def respond(prompt, payload):
            if prompt == 'formula':
                self.planning_inputs.append(payload)
                body = self.plan
            else:
                self.context = payload['task_context']
                body = self.decision
            return AIMessage(content=json.dumps(body))
        app.state.runtime = SimpleNamespace(settings=SimpleNamespace(llm=SimpleNamespace(provider='codex_cli', timeout_seconds=1)),
            respond=respond, request_prompt='router', formula_prompt='formula')
        app.state.conversations = self.repo
        app.state.formula_jobs = {}
        app.state.operation_jobs = {}
        self.app = app
        self.client = TestClient(app)
        self.cid = self.client.post('/conversations').json()['conversation_id']
        self.wid = str(uuid4())
        self.workspace = {'workspace_id': self.wid, 'worksheet_id': 'sheet', 'table_id': 'table',
            'task_type': 'model_normalization', 'sheet_name': 'Sheet1', 'row_count': 90000,
            'target_column_ids': ['replaced'], 'last_result_column_ids': ['replaced'],
            'columns': [{'column_id': key, 'header': header, 'role': role} for key, header, role in [
                ('declared','신고품명','declared_name'), ('trade','거래품명','trade_name'),
                ('model','모델규격명','model_spec'), ('grouped','통일 결과','result'),
                ('replaced','치환 결과','result'), ('cleaned','모델규격명 정제','result'),
                ('formula-result','조건 추출','result')]]}
        self.source = {'task_type': 'formula', 'conversation_id': self.cid, 'formula_job_id': str(uuid4()),
            'instruction': '거래품명의 마지막 단어가 모델규격명 정제에 있을 경우 추출해줘',
            'worksheet_id': 'sheet', 'sheet_name': 'Sheet1', 'address': 'Sheet1!C2:Z90001',
            'row_start': 1, 'row_count': 90000, 'column_start': 2, 'column_count': 24,
            'workspace_id': self.wid, 'table_id': 'table', 'workspace_task_type': 'model_normalization',
            'input_columns': [dict(column_id='trade',column_index=2,header='거래품명',role='trade_name'),
                              dict(column_id='cleaned',column_index=25,header='모델규격명 정제',role='result')],
            'samples': [{'cells': ['FOO AB1','AB1 VVV']}]}
        self.plan = {'version':1,'summary':'두 입력 열을 비교합니다.', 'actions':[
            {'target_range':'AA2:AA90001','anchor_cell':'AA2','formula':'=IF(ISNUMBER(SEARCH(C2,Z2)),C2,"")',
             'mode':'fill_down','output_label':'조건 추출'}]}
        self.result = {'targets':[{'row_start':1,'row_count':90000,'column_start':26,'column_count':1}],
                       'result_column_ids':['formula-result']}

    def chat(self):
        return self.client.post('/chat', json={'conversation_id':self.cid,'request_id':str(uuid4()),
            'message':'후속 작업', 'workspace':self.workspace})

    def preview(self):
        response = self.client.post('/formula-jobs', json=self.source)
        self.assertEqual(response.status_code,200,response.text)
        self.base = '/formula-jobs/'+self.source['formula_job_id']
        planned = self.client.post(self.base+'/analyze')
        self.assertEqual(planned.json()['status'],'PREVIEW_READY',planned.text)
        self.path = self.base+'/previews/'+planned.json()['preview']['preview_id']
        return planned.json()

    def approve(self):
        response = self.client.post(self.path+'/approve',json={'target_ranges':['AA2:AA90001']})
        self.assertEqual(response.status_code,200,response.text)

    def seed_operation(self, result, operation):
        job = OperationJob(source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=self.cid,
            workspace_id=self.wid,worksheet_id='sheet',table_id='table',task_type='model_normalization',
            row_start=1,row_count=90000,operation=operation),status='APPLIED',result_column_ids=[result])
        self.app.state.operation_jobs[str(job.source.operation_job_id)] = job

    def test_group_replace_formula_then_edit_earlier_result(self):
        self.seed_operation('grouped', {'kind':'group','column_ids':['declared','trade'],
                                       'value_column_id':'cleaned','group_mode':'first_non_empty'})
        self.seed_operation('replaced', {'kind':'replace','column_ids':['model'],'find':'X','replacement':'Y'})
        response = self.chat()
        self.assertEqual(response.status_code,200,response.text)
        action = response.json()['ui_action']
        self.assertEqual(action['column_ids'],['trade','cleaned'])
        self.assertEqual(action['workspace_id'],self.wid)
        self.preview()
        self.assertEqual(self.planning_inputs[-1]['selection']['input_columns'][1]['column_index'],25)
        self.approve()
        self.assertEqual(self.client.get(self.base).json()['status'],'APPLYING')
        done = self.client.post(self.path+'/complete',json=self.result)
        self.assertEqual(done.status_code,200,done.text)
        self.decision = {'intent':'operation','operation':{'kind':'replace','column_ids':['grouped'],
            'find':'X','replacement':'Y'},'answer':'예전 통일 결과를 수정합니다.'}
        response = self.chat()
        self.assertEqual(response.json()['ui_action']['operation']['column_ids'],['grouped'])
        records = self.context['execution_history']['records']
        self.assertEqual({r['kind'] for r in records},{'group','replace','formula'})
        self.assertTrue(next(r for r in records if r['kind']=='formula')['result_columns'][0]['can_continue'])
        state = self.repo._conversations[self.cid].workflow
        self.assertEqual(state.task_type,'model_normalization')
        self.assertEqual(state.phase,'WORKSPACE_READY')
        self.assertIsNone(state.active_formula_job_id)
        self.decision['operation']['column_ids']=['formula-result']
        self.assertEqual(self.chat().json()['ui_action']['operation']['column_ids'],['formula-result'])

    def test_missing_formula_columns_asks_instead_of_using_last_selection(self):
        self.decision.pop('formula_column_ids')
        reply = self.chat()
        self.assertEqual(reply.status_code,200)
        self.assertIsNone(reply.json()['ui_action'])
        self.assertIn('사용할 열',reply.json()['answer'])

    def test_failed_or_uncertain_apply_cannot_complete_reapprove_or_replan(self):
        self.preview(); self.approve()
        self.assertEqual(self.client.post(self.path+'/unknown').json()['status'],'UNKNOWN')
        for endpoint,body in [(self.path+'/complete',self.result),
                              (self.path+'/approve',{'target_ranges':['AA2:AA90001']}),
                              (self.base+'/analyze',None)]:
            response=self.client.post(endpoint,json=body)
            self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(len(self.planning_inputs),1)
        self.chat()
        record=next(r for r in self.context['execution_history']['records'] if r['kind']=='formula')
        self.assertEqual(record['status'],'UNKNOWN')
        self.assertEqual(record['result_columns'],[])

    def test_completion_validates_actual_ranges_ids_and_is_idempotent(self):
        self.preview();self.approve()
        for mutation in [dict(result_column_ids=[]),dict(result_column_ids=['trade']),
                         dict(targets=[{'row_start':1,'row_count':89999,'column_start':26,'column_count':1}])]:
            self.assertEqual(self.client.post(self.path+'/complete',json={**self.result,**mutation}).status_code,409)
            self.assertEqual(self.client.get(self.base).json()['status'],'APPLYING')
        for _ in range(2):
            self.assertEqual(self.client.post(self.path+'/complete',json=self.result).status_code,200)
        self.assertEqual(self.client.post(self.path+'/unknown').status_code,409)
        self.assertEqual(self.client.post(self.path+'/complete',json={**self.result,'result_column_ids':['different']}).status_code,409)

    def test_bad_approval_never_mutates_preview(self):
        preview=self.preview()['preview']
        response=self.client.post(self.path+'/approve',json={'target_ranges':['C2:C90001']})
        self.assertEqual(response.status_code,422,response.text)
        job=self.client.get(self.base).json()
        self.assertEqual(job['status'],'PREVIEW_READY')
        self.assertEqual(job['preview'],preview)
        with self.assertRaises(ValidationError):
            FormulaPlan.model_validate({**self.plan,'actions':[self.plan['actions'][0],
                {**self.plan['actions'][0],'target_range':'$AA$2:$AA$90001','anchor_cell':'$AA$2'}]})

    def test_scope_and_deleted_result_do_not_leak_into_next_workspace(self):
        self.preview();self.approve();self.client.post(self.path+'/complete',json=self.result)
        original=copy.deepcopy(self.workspace)
        self.workspace['columns']=[c for c in self.workspace['columns'] if c['column_id']!='formula-result']
        self.chat()
        record=next(r for r in self.context['execution_history']['records'] if r['kind']=='formula')
        self.assertFalse(record['result_columns'][0]['can_continue'])
        self.workspace['workspace_id']=str(uuid4())
        self.chat()
        self.assertEqual(self.context['execution_history']['records'],[])
        self.assertIsNone(self.context['active_formula_job'])
        self.assertEqual(self.context['phase'],'WORKSPACE_READY')
        other=copy.deepcopy(self.source);other.update(formula_job_id=str(uuid4()),workspace_id=self.workspace['workspace_id'])
        self.client.post('/formula-jobs',json=other)
        job=self.app.state.formula_jobs[other['formula_job_id']]
        self.assertEqual(job.planning_context.previous_plans,())
        self.assertIsNone(job.planning_context.previous_plan)

    def test_input_column_mapping_rejects_partial_duplicate_or_outside_scope(self):
        self.assertEqual(len(CreateFormulaJobRequest.model_validate(self.source).samples[0].cells),2)
        for mutate in [lambda p:p.update(table_id=None),
                       lambda p:p['input_columns'][1].update(column_index=26),
                       lambda p:p['input_columns'][1].update(column_id='trade'),
                       lambda p:p.update(samples=[{'cells':['one']}])]:
            payload=copy.deepcopy(self.source);mutate(payload)
            with self.assertRaises(ValidationError):CreateFormulaJobRequest.model_validate(payload)

    def test_exactly_400000_rows_can_continue_as_regular_operation(self):
        source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=self.cid,workspace_id=self.wid,
            worksheet_id='sheet',table_id='table',task_type='model_normalization',row_start=1,row_count=400000,
            operation={'kind':'replace','column_ids':['grouped'],'find':'X','replacement':'Y'})
        self.assertEqual(source.row_count,400000)


class FormulaToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_requires_actual_formula_inputs_and_preserves_order(self):
        workspace={'columns':[{'column_id':'trade'},{'column_id':'cleaned'}], 'target_column_ids':['cleaned']}
        tool=next(t for t in build_request_tools({'workspace':workspace}) if t.name=='start_task')
        result=await tool.ainvoke({'task_type':'formula','input_column_ids':['trade','cleaned']})
        self.assertEqual(result['formula_column_ids'],['trade','cleaned'])
        for args in [{'task_type':'formula'}, {'task_type':'formula','input_column_ids':['missing']},
                     {'task_type':'model_normalization','input_column_ids':['trade']}]:
            with self.assertRaises(ValueError):await tool.ainvoke(args)
