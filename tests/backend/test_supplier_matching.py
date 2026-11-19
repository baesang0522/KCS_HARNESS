import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.operation_jobs import router
from api.errors import service_error_response
from repositories.conversation_repository import MemoryConversation, MemoryConversationRepository
from services.documents.schemas import DocumentWorkspace
from services.errors import ServiceError
from services.investigation import Condition, SupplierTarget
from services.operations.schemas import Row
from services.supplier_matching import compare
from services.similarity import score
from agents.request_tools import build_request_tools
from agents.execution_tools import execution_tools


class SupplierMatchingTests(unittest.TestCase):
    def test_threshold_normalization_and_later_tie(self):
        refs = [dict(group='앞 회사', company_name='ABCDEFGHIJ'), dict(group='뒤 회사', company_name='ABCDEFGHIJ')]
        rows = [Row(excel_row=i+2, values=[value]) for i, value in enumerate(['abcdefghij', 'ABCDEFGHIx', 'ABCDEFGHxx', '', '  ABCDEFGHIJ  '])]
        result = compare(rows, refs)
        self.assertEqual([row.values for row in result.rows], [['뒤 회사','100'],['뒤 회사','90'],['','80'],['',''],['뒤 회사','100']])
        self.assertEqual(compare(rows[:1], list(reversed(refs))).rows[0].values[0], '앞 회사')
        self.assertEqual(compare([Row(excel_row=2, values=['  Acme   steel  '])], [dict(group='회사',company_name='ACME STEEL')]).rows[0].values, ['회사','100'])

    def test_n_by_N_over_old_pair_limit_and_each_duplicate_computed_once(self):
        refs = [dict(group=str(i), company_name=f'COMPANY {i:04}') for i in range(20)]
        rows = [Row(excel_row=i+2, values=[f'COMPANY {i%3000:04}']) for i in range(6000)]
        with patch('services.supplier_matching.score', wraps=score) as calculate:
            result = compare(rows, refs)
            self.assertEqual(calculate.call_count, 60000)
        self.assertEqual(len(result.rows),6000)
        self.assertEqual(result.rows[0].values,result.rows[3000].values)
        self.assertEqual([r.excel_row for r in result.rows],[r.excel_row for r in rows])

    def setUp(self):
        self.app=FastAPI();self.app.include_router(router);self.app.add_exception_handler(ServiceError,service_error_response)
        self.app.state.conversations=MemoryConversationRepository();self.app.state.operation_jobs={};self.app.state.formula_jobs={}
        self.cid=str(uuid4());self.conversation=MemoryConversation()
        self.app.state.conversations._conversations[self.cid]=self.conversation
        self.workspace=dict(workspace_id=str(uuid4()),worksheet_id='sheet',table_id='table',sheet_name='작업',task_type='investigation')
        self.conversation.investigation.workspace=DocumentWorkspace(**self.workspace)
        self.did=uuid4();self.conversation.documents[str(self.did)]=SimpleNamespace(link=None)
        self.conversation.investigation.conditions=[Condition(target=SupplierTarget(kind='supplier',group='1',category='바오 스틸',company_name='BAOSHAN'),
            title='회사',description='원문',status='confirmed',source_document_id=self.did,source_pages=[1]),
            Condition(target=SupplierTarget(kind='supplier',group='2',category='우한 스틸',company_name='WUHAN'),
            title='회사',description='원문',status='confirmed',source_document_id=self.did,source_pages=[1])]
        self.source=dict(operation_job_id=str(uuid4()),conversation_id=self.cid,**{k:v for k,v in self.workspace.items() if k!='sheet_name'},
            row_start=1,row_count=10,operation=dict(kind='match_suppliers',column_ids=['company']))
        self.client=TestClient(self.app)

    def create(self):
        response=self.client.post('/operation-jobs',json=self.source)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def url(self,action): return f"/operation-jobs/{self.source['operation_job_id']}/{action}?conversation_id={self.cid}"

    def test_server_owns_references_and_rejects_changed_order_before_apply(self):
        job=self.create();self.assertEqual([r['group'] for r in job['supplier_references']],['바오 스틸','우한 스틸'])
        self.assertEqual(self.conversation.investigation.conditions[0].target.group,'1')
        preview=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['baoshan']}], 'selected_count':10})
        self.assertEqual(preview.status_code,200,preview.text);self.assertEqual(preview.json()['rows'][0]['values'],['바오 스틸','100'])
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        self.conversation.investigation.conditions.reverse()
        apply=self.client.post(self.url('apply'),json={'mode':'new','anchor':'company','name':'그룹'})
        self.assertEqual(apply.status_code,409,apply.text);self.assertIn('바뀌었습니다',apply.json()['detail'])
        self.assertEqual(self.app.state.operation_jobs[self.source['operation_job_id']].status,'PREVIEW_READY')

    def test_unconfirmed_missing_or_cross_workspace_references_block_before_job_creation(self):
        self.conversation.investigation.conditions[0].status='candidate'
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.conversation.investigation.conditions[0].status='confirmed'
        self.source['workspace_id']=str(uuid4())
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.source['workspace_id']=self.workspace['workspace_id'];self.conversation.documents.clear()
        self.assertEqual(self.client.post('/operation-jobs',json=self.source).status_code,409)
        self.assertEqual(self.app.state.operation_jobs,{})

    def test_changed_reference_blocks_next_batch_and_normal_apply_preserves_existing_checks(self):
        self.create();self.conversation.investigation.conditions[0].target.company_name='changed'
        response=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['BAOSHAN']}]})
        self.assertEqual(response.status_code,409)
        self.conversation.investigation.conditions[0].target.company_name='BAOSHAN'
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        response=self.client.post(self.url('apply'),json={'mode':'new','anchor':'company','name':'그룹'})
        self.assertEqual(response.status_code,200,response.text);self.assertEqual(response.json()['status'],'APPLYING')

    def test_chat_and_agent_reuse_operation_preview_and_do_not_supply_guessed_mappings(self):
        context={'workspace':{**self.workspace,'columns':[{'column_id':'company','header':'해외거래처','role':'company_name'}],'target_column_ids':['company']}}
        tools=build_request_tools(context);tool=next(t for t in tools if t.name=='match_suppliers')
        decision=tool.invoke({})
        self.assertEqual(decision['intent'],'operation');self.assertEqual(decision['operation']['kind'],'match_suppliers')
        self.assertEqual(decision['operation']['mappings'],[])
        self.assertIn('match_suppliers',{t.name for t in execution_tools(context,tools)})

if __name__=='__main__': unittest.main()
