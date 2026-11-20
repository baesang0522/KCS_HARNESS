import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.operation_jobs import router as operations
from api.formula_jobs import router as formulas
from api.write_recovery import router as recovery
from api.errors import service_error_response
from repositories.conversation_repository import MemoryConversationRepository
from services.errors import ServiceError
from services.formula.schemas import FormulaPlan
from services.debug_log import job_event
from services.operations.jobs import CreateOperationJob


class JobLoggingTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        for router in (operations, formulas, recovery): self.app.include_router(router)
        self.app.add_exception_handler(ServiceError, service_error_response)
        self.app.state.conversations = MemoryConversationRepository()
        self.cid = asyncio.run(self.app.state.conversations.create())
        self.origin, self.jid = str(uuid4()), str(uuid4())
        self.app.state.operation_jobs, self.app.state.formula_jobs = {}, {}
        self.app.state.runtime = SimpleNamespace()
        self.client = TestClient(self.app)
        self.source = dict(operation_job_id=self.jid, conversation_id=self.cid, origin_request_id=self.origin,
            workspace_id=str(uuid4()), worksheet_id='sheet', table_id='table', task_type='investigation',
            row_start=1, row_count=2, operation=dict(kind='preprocess',column_ids=['in'],rules=[dict(operation='trim')]))
        self.base = '/operation-jobs/' + self.jid
        capture = patch('builtins.print');self.output = capture.start();self.addCleanup(capture.stop)

    def events(self):
        events = [json.loads(call.args[0]) for call in self.output.call_args_list]
        return [event for event in events if event.get("job_id")]

    def post(self, path, body=None, status=200):
        reply = self.client.post(path, params={'conversation_id':self.cid}, json=body)
        self.assertEqual(reply.status_code, status, reply.text)
        return reply.json()

    def prepare(self):
        self.post('/operation-jobs', self.source)
        for row in (2, 3):
            result = self.post(self.base+'/preview',dict(selected_count=2,rows=[dict(excel_row=row,values=['  PRIVATE CELL  '])]))
            self.assertEqual(result['rows'][0]['values'],['PRIVATE CELL'])
        self.post(self.base+'/status',dict(status='PREVIEW_READY'))

    def apply(self): self.post(self.base+'/apply',dict(mode='new',anchor='in',name='결과'))

    def test_batches_and_actual_completion_share_origin_without_logging_cells(self):
        self.prepare();self.apply()
        self.assertFalse(any(e.get('status') == 'APPLIED' for e in self.events()))
        self.post(self.base+'/status',dict(status='APPLIED',result_column_ids=['out']))
        self.post(self.base+'/status',dict(status='APPLIED',result_column_ids=['out']))
        events = self.events()
        self.assertTrue(all(e['origin_request_id'] == self.origin and e['job_id'] == self.jid and e['conversation_id'] == self.cid for e in events))
        previews = [e for e in events if e['event'] == 'operation.preview.completed']
        self.assertEqual([e['batch_row_count'] for e in previews],[1,1])
        self.assertEqual([e['changed_count'] for e in previews],[1,1])
        self.assertEqual(events[-1]['status'],'APPLIED');self.assertTrue(events[-1]['replayed'])
        self.assertNotIn('PRIVATE CELL',str(self.output.call_args_list))
        self.assertTrue(all(e['elapsed_ms'] >= 0 for e in events if 'elapsed_ms' in e))

    def test_rejected_preview_and_apply_are_logged_without_success_or_state_change(self):
        self.post('/operation-jobs',self.source)
        self.post(self.base+'/preview',dict(rows=[dict(excel_row=99,values=['PRIVATE CELL'])]),422)
        self.post(self.base+'/apply',dict(mode='new',anchor='in'),409)
        self.assertEqual(self.app.state.operation_jobs[self.jid].status,'CREATED')
        failed = [e for e in self.events() if e['event'].endswith('.failed')]
        self.assertEqual([e['event'] for e in failed],['operation.preview.failed','operation.apply_start.failed'])
        self.assertTrue(all(e['origin_request_id'] == self.origin for e in failed))
        self.assertNotIn('PRIVATE CELL',str(self.output.call_args_list))

    def test_unknown_write_and_readonly_recovery_keep_origin_and_distinguish_completion(self):
        self.prepare();self.apply();path = '/write-recovery/operation/'+self.jid
        evidence=dict(worksheet_id='sheet',table_id='table',identity_column_id='id',blocks=[
            dict(row_start=1,row_count=2,column_start=2,column_id='out',before='a'*64,expected='b'*64,identities='c'*64)])
        reply=self.client.put(path+'/evidence',params={'conversation_id':self.cid},json=evidence)
        self.assertEqual(reply.status_code,200,reply.text)
        self.post(self.base+'/status',dict(status='UNKNOWN',error_message='completion response lost'))
        self.assertEqual(self.events()[-1]['status'],'UNKNOWN')
        self.assertEqual(self.events()[-1]['client_error'],'completion response lost')
        self.assertFalse(any(e.get('status') == 'APPLIED' for e in self.events()))
        result=self.post(path+'/check',dict(values=['b'*64],identities=['c'*64],formulas=[False]))
        self.assertEqual(result['status'],'APPLIED');event=self.events()[-1]
        self.assertEqual((event['event'],event['status'],event['method']),('write_recovery.check.completed','APPLIED','comparison'))
        self.assertEqual(event['origin_request_id'],self.origin)
        self.assertNotIn('b'*64,str(self.output.call_args_list))

    def test_old_clients_and_broken_stdout_do_not_change_execution(self):
        self.source.pop('origin_request_id')
        with patch('builtins.print',side_effect=BrokenPipeError):
            self.prepare();self.apply()
            result=self.post(self.base+'/status',dict(status='APPLIED',result_column_ids=['out']))
        self.assertEqual(result['status'],'APPLIED');self.assertIsNone(result['source']['origin_request_id'])

    def test_formula_plan_apply_and_completion_or_unknown_are_correlated(self):
        for lost in (False, True):
            jid=str(uuid4());base='/formula-jobs/'+jid
            source=dict(task_type='formula',conversation_id=self.cid,origin_request_id=self.origin,formula_job_id=jid,
                instruction='두 배 계산',worksheet_id='sheet',sheet_name='Sheet1',address='Sheet1!A2:A3',
                row_start=1,column_start=0,row_count=2,column_count=1,samples=[dict(cells=['1'])])
            self.post('/formula-jobs',source)
            plan=FormulaPlan(version=1,summary='계산',actions=[dict(target_range='B2:B3',anchor_cell='B2',formula='=A2*2',mode='fill_down')])
            with patch('services.formula.service.generate_formula_plan',return_value=plan): result=self.post(base+'/analyze')
            pid=result['preview']['preview_id'];phase=base+'/previews/'+pid
            self.post(phase+'/approve')
            if lost:
                result=self.post(phase+'/unknown',dict(error_message='Excel disconnected'))
                self.assertEqual(result['status'],'UNKNOWN')
                self.assertEqual(self.events()[-1]['client_error'],'Excel disconnected')
                self.assertFalse(any(e.get('status')=='APPLIED' and e['job_id']==jid for e in self.events()))
                self.post(phase+'/unknown')
            else:
                result=self.post(phase+'/complete',dict(targets=[dict(row_start=1,row_count=2,column_start=1)]))
                self.assertEqual(result['status'],'APPLIED')
            events=[e for e in self.events() if e['job_id']==jid]
            self.assertTrue(all(e['origin_request_id']==self.origin for e in events))
            self.assertTrue(any(e['event']=='formula.preview.completed' and e['status']=='PREVIEW_READY' for e in events))

    def test_cancellation_is_logged_and_still_propagates(self):
        with self.assertRaises(asyncio.CancelledError):
            with job_event('operation.preview',CreateOperationJob(**self.source),'operation'): raise asyncio.CancelledError()
        self.assertEqual(self.events()[-1]['error_type'],'CancelledError')
        self.assertFalse(any(e['event'].endswith('.completed') for e in self.events()))
