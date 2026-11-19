import copy
import unittest
from types import SimpleNamespace
from uuid import uuid4
from services.operations.jobs import CreateOperationJob, OperationJob, OutputPlacement
from services.write_recovery import WriteEvidence, WriteObservation, save_evidence, recover, ensure_resolved
from services.errors import ConflictError


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.job = OperationJob(source=CreateOperationJob(operation_job_id=uuid4(), conversation_id=uuid4(), workspace_id=uuid4(),
            worksheet_id='sheet', table_id='table', task_type='investigation', row_start=1,row_count=2,
            operation={'kind':'preprocess','column_ids':['in'],'rules':[{'operation':'uppercase'}]}),
            selected_count=2, status='APPLYING', output=OutputPlacement(mode='new',anchor='in',name='result'))
        self.evidence = WriteEvidence(worksheet_id='sheet',table_id='table',identity_column_id='id',blocks=[
            dict(row_start=i,row_count=1,column_start=2,column_id='out',before='a'*64,expected='b'*64,identities='c'*64) for i in (1,2)])
        save_evidence(self.job,'operation',self.evidence)
    def observation(self, values, **extra):
        return WriteObservation(values=[v*64 for v in values],identities=['c'*64]*len(values),formulas=[False]*len(values),**extra)
    def test_lost_ack_can_complete_without_reapplying_and_is_idempotent(self):
        self.job.status='UNKNOWN'
        result=recover(self.job,'operation',self.observation('bb'))
        self.assertEqual(result['status'],'APPLIED'); self.assertEqual(self.job.result_column_ids,['out'])
        self.assertEqual(recover(self.job,'operation',self.observation('bb')),result)
    def test_partial_unknown_and_not_applied(self):
        for values,status,label in [('ba','UNKNOWN','partial'),('dd','UNKNOWN','unknown'),('aa','NOT_APPLIED','not_applied')]:
            job=self.job.model_copy(deep=True)
            result=recover(job,'operation',self.observation(values))
            self.assertEqual(result['status'],status);self.assertEqual(result['checks'][-1]['result'],label)
    def test_manual_confirmation_is_audited_and_does_not_hide_remaining_formulas(self):
        observation=self.observation('dd',conclusion='completed',note='결과 두 행을 직접 확인함')
        result=recover(self.job,'operation',observation)
        self.assertEqual(result['status'],'APPLIED');self.assertEqual(result['checks'][-1]['method'],'user')
        self.job.status='UNKNOWN';observation.formulas[0]=True
        with self.assertRaises(ConflictError):recover(self.job,'operation',observation)
    def test_identity_change_blocks_automatic_success(self):
        observation=self.observation('bb');observation.identities[0]='d'*64
        self.assertEqual(recover(self.job,'operation',observation)['status'],'UNKNOWN')
    def test_evidence_is_immutable_and_output_bound(self):
        changed=self.evidence.model_copy(deep=True);changed.blocks[0].expected='d'*64
        with self.assertRaises(ConflictError):save_evidence(self.job,'operation',changed)
        changed=self.evidence.model_copy(deep=True);changed.blocks[0].column_id='in'
        with self.assertRaises(ConflictError):save_evidence(self.job,'operation',changed)
    def test_unresolved_write_blocks_manual_and_other_conversations(self):
        state=SimpleNamespace(operation_jobs={'old':self.job},formula_jobs={})
        with self.assertRaises(ConflictError):ensure_resolved(state,self.job.source,'new')
        recover(self.job,'operation',self.observation('aa'))
        ensure_resolved(state,self.job.source,'new')
    def test_missing_evidence_keeps_manual_completed_unresolved(self):
        self.job.write_evidence=None
        result=recover(self.job,'operation',WriteObservation(values=[],identities=[],formulas=[],conclusion='completed',note='범위 확인 불가'))
        self.assertEqual(result['status'],'UNKNOWN');self.assertEqual(result['checks'][-1]['method'],'user')

    def test_formula_completion_requires_approved_ranges_and_frozen_values(self):
        from services.formula.schemas import FormulaJob, FormulaPreview, FormulaPlan, CreateFormulaJobRequest
        source=CreateFormulaJobRequest(formula_job_id=uuid4(),conversation_id=self.job.source.conversation_id,
            task_type='formula',instruction='두 배',worksheet_id='sheet',sheet_name='Sheet1',address='Sheet1!A2:A3',
            row_start=1,row_count=2,column_start=0,column_count=1,samples=[{'cells':['1']}])
        preview=FormulaPreview(plan=FormulaPlan(version=1,summary='두 배',actions=[dict(target_range='B2:B3',anchor_cell='B2',formula='=A2*2',mode='fill_down')]))
        job=FormulaJob(source=source,status='APPLYING',preview=preview,approved_preview_id=preview.preview_id)
        evidence=WriteEvidence(worksheet_id='sheet',blocks=[dict(row_start=1,row_count=2,column_start=1,before='a'*64)])
        save_evidence(job,'formula',evidence)
        evidence.blocks[0].expected='b'*64;save_evidence(job,'formula',evidence)
        observation=WriteObservation(values=['b'*64],identities=[None],formulas=[True])
        self.assertEqual(recover(job,'formula',observation)['status'],'UNKNOWN')
        observation.formulas=[False]
        self.assertEqual(recover(job,'formula',observation)['status'],'APPLIED')
        self.assertEqual(job.result.targets[0].column_start,1)

    def test_recovery_api_lists_cross_conversation_conflicts_and_never_calls_apply(self):
        import asyncio
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.write_recovery import router
        from api.errors import service_error_response
        from repositories.conversation_repository import MemoryConversationRepository
        from services.errors import ServiceError
        repo=MemoryConversationRepository();cid=asyncio.run(repo.create());other=asyncio.run(repo.create())
        self.job.source.conversation_id=__import__('uuid').UUID(cid)
        app=FastAPI();app.include_router(router);app.add_exception_handler(ServiceError,service_error_response)
        app.state.conversations=repo;app.state.operation_jobs={str(self.job.source.operation_job_id):self.job};app.state.formula_jobs={}
        client=TestClient(app)
        self.assertEqual(client.get('/write-recovery',params={'conversation_id':other}).json(),[])
        records=client.get('/write-recovery',params={'conversation_id':other,'worksheet_id':'sheet','table_id':'table'}).json()
        self.assertEqual(records[0]['conversation_id'],cid)
        url='/write-recovery/operation/'+str(self.job.source.operation_job_id)+'/check'
        payload=self.observation('bb').model_dump()
        self.assertEqual(client.post(url,params={'conversation_id':other},json=payload).status_code,404)
        self.assertEqual(client.post(url,params={'conversation_id':cid},json=payload).json()['status'],'APPLIED')
        self.assertEqual(client.get('/write-recovery',params={'conversation_id':cid}).json(),[])
        records=client.get('/write-recovery',params={'conversation_id':cid,'job_id':str(self.job.source.operation_job_id)}).json()
        self.assertEqual(records[0]['status'],'APPLIED')

    def test_saved_completion_receipt_still_records_current_value_mismatch_without_downgrade(self):
        self.job.status='APPLIED';self.job.result_column_ids=['out']
        result=recover(self.job,'operation',self.observation('dd'))
        self.assertEqual(result['status'],'APPLIED')
        self.assertEqual(result['checks'][-1]['result'],'unknown')
        self.assertEqual(self.job.result_column_ids,['out'])
