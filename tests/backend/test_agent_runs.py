import asyncio
import copy
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from api.chat import router as chat_router
from api.agent_runs import router as agent_router
from api.operation_jobs import router as operation_router
from api.formula_jobs import router as formula_router
from api.errors import service_error_response
from repositories.conversation_repository import MemoryConversationRepository, ConversationNotFound
from services.errors import ServiceError
from services.agent_runs import MAX_STEPS


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.queue = [], []
        outer = self
        class Model:
            def bind_tools(self, tools, **kwargs):
                self.names = {tool.name for tool in tools}
                return self
            async def ainvoke(self, messages):
                outer.calls.append(json.loads(messages[1].content)["task_context"])
                name, args = outer.queue.pop(0)
                assert name in self.names, name
                return AIMessage(content="", tool_calls=[{"id": str(uuid4()), "name": name, "args": args}])
        app = FastAPI()
        for router in (chat_router, agent_router, operation_router, formula_router): app.include_router(router)
        app.add_exception_handler(ServiceError, service_error_response)
        app.add_exception_handler(ConversationNotFound, service_error_response)
        app.state.conversations = MemoryConversationRepository()
        app.state.operation_jobs, app.state.formula_jobs = {}, {}
        app.state.runtime = SimpleNamespace(model=Model(), tools_prompt="router",
            settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=120)))
        self.app, self.client = app, TestClient(app)
        self.cid = self.client.post('/conversations').json()['conversation_id']
        self.workspace = dict(workspace_id=str(uuid4()), worksheet_id='sheet', table_id='table', task_type='investigation',
            sheet_name='조사', row_start=1, row_count=3, target_column_ids=['name'],
            columns=[dict(column_id='name',header='상호',role='reference'),dict(column_id='flag',header='판정',role='reference')])
        self.rows = [dict(identity=i,excel_row=i+1,values=[value]) for i,value in enumerate(['AA','AB','AA'],1)]

    def chat(self, tool, args, message='목표를 수행해줘'):
        self.queue.append((tool,args))
        response=self.client.post('/chat',json=dict(conversation_id=self.cid,request_id=str(uuid4()),message=message,workspace=self.workspace))
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def start(self):
        reply=self.chat('start_agent',dict(goal='실제 상호 값을 읽고 AA와 유사도를 비교해 보여줘'))
        self.rid=reply['ui_action']['run_id']
        self.base=f'/conversations/{self.cid}/agent-runs/{self.rid}'
        return reply

    @property
    def agent_run(self): return self.app.state.conversations._conversations[self.cid].agent_runs[self.rid]

    def advance(self, tool=None,args=None,receipt=None,request_id=None,workspace=None):
        if tool:self.queue.append((tool,args or {}))
        self.last_payload=dict(request_id=request_id or str(uuid4()),workspace=workspace or self.workspace,receipt=receipt)
        response=self.client.post(self.base+'/advance',json=self.last_payload)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def read(self):
        return self.advance('read_workspace',dict(column_ids=['name']))

    def receipt(self,state,status='SUCCEEDED',**extra):
        return dict(step_id=state['step']['step_id'],status=status,**extra)

    def create_job(self,state):
        source=dict(operation_job_id=str(uuid4()),conversation_id=self.cid,workspace_id=self.workspace['workspace_id'],
            worksheet_id='sheet',table_id='table',task_type='investigation',row_start=1,row_count=3,
            operation=state['step']['action']['operation'])
        response=self.client.post('/operation-jobs',json=source)
        self.assertEqual(response.status_code,200,response.text)
        jid=source['operation_job_id']
        bound=self.client.post(self.base+'/bind',json=dict(step_id=state['step']['step_id'],kind='operation',job_id=jid))
        self.assertEqual(bound.status_code,200,bound.text)
        return jid

    def write_step(self):
        return self.advance('update_matching_rows',dict(condition_column_id='name',operator='equals',value='AA',destination_column_id='flag',assigned_value='Y'))

    def test_full_read_compare_result_loop_and_duplicate_receipt(self):
        self.start();first=self.read()
        second=self.advance('compare_values',dict(settings=dict(column_id='name',method='levenshtein',base_value='AA')),
            self.receipt(first,rows=self.rows))
        self.assertEqual(second['observation']['row_count'],3)
        self.assertEqual([g['count'] for g in second['observation']['groups']],[2,1])
        self.assertEqual(self.calls[-1]['agent_run']['observation']['groups'][0]['first_row_id'],1)
        completed=self.advance('answer_question',dict(answer='AA 2행, AB 1행이며 유사도는 50점입니다.'),self.receipt(second,rows=self.rows))
        self.assertEqual(completed['status'],'COMPLETED')
        self.assertEqual(completed['observation']['rows'][0]['score'],50)
        count=len(self.calls)
        again=self.client.post(self.base+'/advance',json=self.last_payload)
        self.assertEqual(again.json()['status'],'COMPLETED');self.assertEqual(len(self.calls),count)
        wrong=copy.deepcopy(self.last_payload);wrong['receipt']['rows'][0]['values']=['ZZ']
        self.assertEqual(self.client.post(self.base+'/advance',json=wrong).status_code,409)
        self.assertEqual(self.app.state.operation_jobs,{})

    def test_write_waits_for_actual_job_and_requires_preview_approval(self):
        self.start();state=self.write_step()
        self.assertEqual(state['status'],'WAITING_USER');self.assertEqual(self.app.state.operation_jobs,{})
        jid=self.create_job(state);job=self.app.state.operation_jobs[jid]
        waiting=self.advance(receipt=self.receipt(state));self.assertEqual(waiting['status'],'WAITING_USER')
        self.assertEqual(job.status,'CREATED')
        job.status='APPLIED';job.result_column_ids=['flag']
        done=self.advance('answer_question',dict(answer='실제 적용 결과를 확인했습니다.'),self.receipt(state))
        self.assertEqual(done['status'],'COMPLETED')
        self.assertEqual(self.calls[-1]['agent_run']['observation']['status'],'APPLIED')
        self.assertEqual(self.calls[-1]['agent_run']['completed_jobs'][0]['job_id'],jid)

    def test_unknown_write_never_reissues_even_after_resume(self):
        self.start();state=self.write_step();jid=self.create_job(state)
        self.app.state.operation_jobs[jid].status='UNKNOWN'
        stopped=self.advance(receipt=self.receipt(state,status='UNKNOWN',message='일부 작성 가능'))
        self.assertEqual(stopped['status'],'UNKNOWN')
        self.chat('resume_agent',{},'확인했으니 이어가줘')
        count=len(self.calls);again=self.advance()
        self.assertEqual(again['status'],'UNKNOWN');self.assertEqual(len(self.calls),count)
        self.assertEqual(len(self.app.state.operation_jobs),1)

    def test_failed_and_completed_but_local_metadata_failed_do_not_continue(self):
        for status in ['FAILED','APPLIED']:
            with self.subTest(status=status):
                self.start();state=self.write_step();jid=self.create_job(state)
                self.app.state.operation_jobs[jid].status=status
                count=len(self.calls)
                done=self.advance(receipt=self.receipt(state,status='UNKNOWN' if status=='APPLIED' else 'FAILED',message='저장 실패'))
                self.assertIn(done['status'],['FAILED','UNKNOWN']);self.assertEqual(len(self.calls),count)

    def test_forged_write_completion_without_job_fails(self):
        self.start();state=self.write_step()
        stopped=self.advance(receipt=self.receipt(state))
        self.assertEqual(stopped['status'],'FAILED')
        self.assertIn('실행 기록 없이',stopped['answer'])

    def test_manual_action_pauses_then_resume_rereads_and_receives_latest_context(self):
        self.start();state=self.read()
        self.advance('ask_user',dict(question='비교 방식을 알려주세요.'),self.receipt(state,rows=self.rows))
        self.chat('replace_text',dict(column_id='name',find='AA',replacement='CC'),'AA만 CC로 바꿔줘')
        self.assertEqual(self.agent_run.status,'PAUSED')
        self.workspace['row_filter']=dict(column_id='flag',operator='equals',value='N')
        self.chat('resume_agent',{},'직접 고쳤어. 계속해줘')
        self.assertIsNone(self.agent_run.observation)
        resumed=self.read()
        self.assertEqual(resumed['status'],'WAITING_EXCEL')
        self.assertEqual(self.calls[-1]['workspace']['row_filter']['value'],'N')
        self.assertIn('직접 고쳤어',self.calls[-1]['agent_run']['user_reply'])

    def test_wrong_workspace_step_conversation_and_late_response_rejected(self):
        self.start();state=self.read();payload=dict(request_id=str(uuid4()),workspace=self.workspace,receipt=self.receipt(state,rows=self.rows))
        wrong=copy.deepcopy(payload);wrong['workspace']['workspace_id']=str(uuid4())
        self.assertEqual(self.client.post(self.base+'/advance',json=wrong).status_code,409)
        wrong=copy.deepcopy(payload);wrong['receipt']['step_id']=str(uuid4())
        self.assertEqual(self.client.post(self.base+'/advance',json=wrong).status_code,409)
        other=self.client.post('/conversations').json()['conversation_id']
        self.assertEqual(self.client.get(f'/conversations/{other}/agent-runs').json(),{'run':None})
        self.assertEqual(self.client.post(self.base.replace(self.cid,other)+'/advance',json=payload).status_code,404)
        self.client.post(self.base+'/pause')
        self.assertEqual(self.client.post(self.base+'/advance',json=payload).status_code,409)

    def test_cancellation_during_excel_wait_ignores_late_receipt(self):
        self.start();state=self.read();rid=self.agent_run.request_id
        self.client.post(f'/conversations/{self.cid}/requests/{rid}/cancel')
        self.assertEqual(self.agent_run.status,'CANCELLED')
        payload=dict(request_id=str(uuid4()),workspace=self.workspace,receipt=self.receipt(state,rows=self.rows))
        self.assertEqual(self.client.post(self.base+'/advance',json=payload).status_code,409)

    def test_repeat_and_iteration_guards_pause_without_claiming_completion(self):
        self.start();state=self.read()
        again=self.advance('read_workspace',dict(column_ids=['name']),self.receipt(state,rows=self.rows))
        self.assertEqual(again['status'],'PAUSED');self.assertIn('반복',again['answer'])
        self.start();self.agent_run.steps=MAX_STEPS
        limited=self.advance();self.assertEqual(limited['status'],'PAUSED')

    def test_deadline_and_empty_read(self):
        self.start();self.agent_run.deadline=0
        self.assertEqual(self.advance()['status'],'PAUSED')
        self.start();state=self.read()
        done=self.advance('answer_question',dict(answer='일치하는 행이 없습니다.'),self.receipt(state,rows=[]))
        self.assertEqual(done['status'],'COMPLETED');self.assertEqual(done['observation']['row_count'],0)

    def test_invalid_rows_fail_before_next_model_call_and_no_truncation(self):
        self.start();state=self.read();bad=self.rows+[self.rows[0]];count=len(self.calls)
        result=self.advance(receipt=self.receipt(state,rows=bad))
        self.assertEqual(result['status'],'FAILED');self.assertEqual(len(self.calls),count)
        self.start();state=self.advance('compare_values',dict(settings=dict(column_id='name',method='sequence')))
        longrows=[dict(identity=1,excel_row=2,values=['a'*201])]
        result=self.advance(receipt=self.receipt(state,rows=longrows))
        self.assertEqual(result['status'],'FAILED');self.assertIn('200',result['answer'])

    def test_model_cannot_finish_without_actual_evidence(self):
        self.start();result=self.advance('answer_question',dict(answer='다 했습니다.'))
        self.assertEqual(result['status'],'FAILED');self.assertIn('실제 실행 결과 없이',result['answer'])

    def test_binding_other_workspace_and_replacing_started_job_rejected(self):
        self.start();state=self.write_step();jid=self.create_job(state)
        self.app.state.operation_jobs[jid].source.workspace_id=uuid4()
        payload=dict(step_id=state['step']['step_id'],kind='operation',job_id=jid)
        self.assertEqual(self.client.post(self.base+'/bind',json=payload).status_code,409)

    def test_resume_discards_unapplied_preview_but_preserves_actual_write_record(self):
        self.start();state=self.write_step();jid=self.create_job(state)
        self.app.state.operation_jobs[jid].status='PREVIEW_READY'
        self.chat('resume_agent',{},'직접 고쳤어. 최신 값으로 이어가줘')
        self.assertEqual(self.app.state.operation_jobs[jid].status,'CANCELLED')
        self.assertIsNone(self.agent_run.step)
        self.assertEqual(self.read()['status'],'WAITING_EXCEL')

    def test_read_response_cannot_change_scope_and_completed_retry_does_not_restart(self):
        self.start();state=self.read()
        workspace=copy.deepcopy(self.workspace);workspace['row_count']=2
        payload=dict(request_id=str(uuid4()),workspace=workspace,receipt=self.receipt(state,rows=self.rows[:2]))
        self.assertEqual(self.client.post(self.base+'/advance',json=payload).status_code,409)
        self.advance('answer_question',dict(answer='확인했습니다.'),self.receipt(state,rows=self.rows))
        count=len(self.calls);self.assertEqual(self.advance()['status'],'COMPLETED')
        self.assertEqual(len(self.calls),count)

    def test_formula_handoff_contains_only_this_steps_instruction_and_no_auto_write(self):
        self.start()
        state=self.advance('calculate_formula',dict(instruction='상호의 글자 수를 계산',input_column_ids=['name']))
        self.assertEqual(state['status'],'WAITING_USER')
        self.assertEqual(state['step']['action']['instruction'],'상호의 글자 수를 계산')
        self.assertEqual(state['step']['action']['column_ids'],['name'])
        self.assertEqual(self.app.state.formula_jobs,{})

    def test_model_timeout_is_reported_and_cancelled_without_followup(self):
        self.start()
        async def slow(messages): await asyncio.sleep(1)
        self.app.state.runtime.model.ainvoke=slow
        self.app.state.runtime.settings.llm.timeout_seconds=0.01
        self.assertIn('시간 한도',self.advance()['answer'])
        self.assertEqual(self.agent_run.status,'FAILED')

    def test_local_completion_failure_keeps_job_link_for_explicit_reconciliation(self):
        self.start();state=self.write_step();jid=self.create_job(state)
        self.app.state.operation_jobs[jid].status='APPLIED'
        self.app.state.operation_jobs[jid].result_column_ids=['flag']
        self.advance(receipt=self.receipt(state,status='UNKNOWN',message='작업 정보 저장 실패'))
        self.assertEqual(self.agent_run.step['job']['job_id'],jid)
        self.chat('resume_agent',{},'결과를 확인했어. 최신 상태로 계속해줘')
        result=self.advance('read_workspace',dict(column_ids=['flag']))
        self.assertEqual(result['status'],'WAITING_EXCEL')
        self.assertEqual(len(self.agent_run.history),1)

    def test_new_goal_cannot_automatically_repeat_an_uncertain_write(self):
        self.start();state=self.write_step();jid=self.create_job(state)
        self.app.state.operation_jobs[jid].status='UNKNOWN'
        self.start();again=self.write_step()
        self.assertEqual(again['status'],'UNKNOWN')
        self.assertEqual(len(self.app.state.operation_jobs),1)

    def test_receipt_rejects_physical_rows_outside_current_target(self):
        self.start();state=self.read()
        result=self.advance(receipt=self.receipt(state,rows=[dict(identity=1,excel_row=100,values=['AA'])]))
        self.assertEqual(result['status'],'FAILED');self.assertIn('범위 밖',result['answer'])
