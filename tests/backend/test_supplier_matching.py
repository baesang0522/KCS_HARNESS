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
from services.investigation.schemas import Condition, SupplierTarget
from services.operations.schemas import Row, Operation
from pydantic import ValidationError
from services.errors import ConflictError
from services.write_recovery import WriteEvidence, WriteObservation, save_evidence, recover, validate_evidence
from services.supplier_matching import compare
from services.similarity import score
from agents.request_tools import build_request_tools
from agents.execution_tools import execution_tools


class SupplierMatchingTests(unittest.TestCase):
    def test_threshold_normalization_and_later_tie(self):
        refs = [dict(group='앞 회사', company_name='ABCDEFGHIJ'), dict(group='뒤 회사', company_name='ABCDEFGHIJ')]
        rows = [Row(excel_row=i+2, values=[value]) for i, value in enumerate(['abcdefghij', 'ABCDEFGHIx', 'ABCDEFGHxx', '', '  ABCDEFGHIJ  '])]
        result = compare(rows, refs, "levenshtein")
        self.assertEqual([row.values for row in result.rows], [['뒤 회사','100'],['뒤 회사','90'],['','80'],['',''],['뒤 회사','100']])
        self.assertEqual(compare(rows[:1], list(reversed(refs))).rows[0].values[0], '앞 회사')
        self.assertEqual(compare([Row(excel_row=2, values=['  Acme   steel  '])], [dict(group='회사',company_name='ACME STEEL')]).rows[0].values, ['회사','100'])

    def test_custom_threshold_boundary_ties_and_auto_fallback(self):
        refs = [dict(group='앞', company_name='A'), dict(group='뒤', company_name='B')]
        rows = [Row(excel_row=i+2, values=[v]) for i, v in enumerate(['above', 'boundary', 'below', ''])]
        scores = {'ABOVE': 84.615385, 'BOUNDARY': 80, 'BELOW': 79.9999996}
        for method in ['auto', 'levenshtein', 'sequence']:
            with patch('services.supplier_matching.score', side_effect=lambda a,b,m: scores[a]) as calculate:
                result = compare(rows, refs, method, threshold=80)
            self.assertEqual([r.values for r in result.rows], [['뒤','84.615385'], ['뒤','80'], ['','80'], ['','']])
            if method == 'auto':
                self.assertEqual(calculate.call_count, 8)
                self.assertFalse(any(c.args[0] != 'BELOW' and c.args[2] == 'sequence' for c in calculate.call_args_list))
        self.assertEqual(compare(rows[:1], refs, 'sequence', threshold=0).rows[0].values[0], '뒤')
        self.assertEqual(compare([Row(excel_row=2, values=['A'])], refs, threshold=100).rows[0].values, ['앞','100'])
        with patch('services.supplier_matching.score', return_value=84.615385):
            self.assertEqual(compare(rows[:1], refs, threshold=84.7).rows[0].values[0], '')
            self.assertEqual(compare(rows[:1], refs, threshold=84.6).rows[0].values[0], '뒤')

    def test_tool_threshold_reaches_saved_job_and_preview(self):
        context={'workspace':{'columns':[dict(column_id='company',header='상호',role='company_name')], 'target_column_ids':['company']}}
        tool=next(t for t in build_request_tools(context) if t.name=='match_suppliers')
        self.assertEqual(tool.invoke({})['operation']['similarity_threshold'], 90)
        for threshold in [-1, 101, float('nan'), float('inf')]:
            with self.subTest(threshold=threshold), self.assertRaises(ValidationError):
                tool.invoke({'threshold': threshold})
        self.source['operation'] = tool.invoke({'threshold':80})['operation']
        job = self.create()
        self.assertEqual(job['source']['operation']['similarity_threshold'], 80)
        with patch('services.supplier_matching.score', return_value=84.615385):
            response=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['company']}]})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['rows'][0]['values'], ['우한 스틸','84.615385'])
        self.assertEqual(tool.invoke({'threshold':0})['operation']['similarity_threshold'],0)
        with self.assertRaises(ValidationError):
            Operation(kind='set', column_ids=['company'], assigned_value='Y', similarity_threshold=80)

    def test_n_by_N_over_old_pair_limit_and_each_duplicate_computed_once(self):
        refs = [dict(group=str(i), company_name=f'COMPANY {i:04}') for i in range(20)]
        rows = [Row(excel_row=i+2, values=[f'COMPANY {i%3000:04}']) for i in range(6000)]
        with patch('services.supplier_matching.score', wraps=score) as calculate:
            result = compare(rows, refs, "levenshtein")
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


    def test_sequence_uses_shared_bidirectional_score_with_same_threshold_and_tie_rule(self):
        refs = [dict(group='앞 회사', company_name='ABCDEFGHIJ'), dict(group='뒤 회사', company_name='ABCDEFGHIJ')]
        rows = [Row(excel_row=i+2, values=[v]) for i,v in enumerate(['ABCDEFGHIx','ABCDEFGHxx'])]
        result = compare(rows,refs,'sequence')
        self.assertEqual([r.values for r in result.rows],[['뒤 회사','90'],['','80']])
        self.assertEqual(compare(rows,list(reversed(refs)),'sequence').rows[0].values[0],'앞 회사')
        self.assertEqual(compare([Row(excel_row=2,values=['TIDE'])],[dict(group='회사',company_name='DIET')],'sequence').rows[0].values,['','37.5'])
        with self.assertRaises(ValueError): compare(rows,refs,'unknown')

    def test_api_passes_requested_sequence_method_through_job_preview(self):
        self.conversation.investigation.conditions[0].target.company_name='JIANGSU SHAGANG INTERNATIONAL TRADE CO., LTD.'
        self.source['operation']['similarity_method']='sequence'
        self.create()
        result=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['JIANGSU SHANGANG INTERNATIONALTRADE CO LTD']}]})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['rows'][0]['values'],['바오 스틸','94.252874'])
        self.assertEqual(compare([Row(excel_row=2,values=['JIANGSU SHANGANG INTERNATIONALTRADE CO LTD'])],
            [dict(group='회사',company_name='JIANGSU SHAGANG INTERNATIONAL TRADE CO., LTD.')], 'levenshtein').rows[0].values,['','88.888889'])

    def test_existing_pair_always_selects_blank_groups_and_validates_method_and_destinations(self):
        output=dict(mode='existing',column_id='group',score_column_id='score')
        operation=Operation(kind='match_suppliers',column_ids=['company'],output=output,similarity_method='sequence')
        self.assertEqual(operation.condition.column_id,'group');self.assertEqual(operation.condition.operator,'blank')
        for changes in [dict(similarity_method='unknown'),dict(condition=dict(column_id='group',operator='not_blank')),
                        dict(output={**output,'score_column_id':'company'}),dict(output={**output,'score_column_id':'group'})]:
            with self.assertRaises(ValidationError): Operation.model_validate({**operation.model_dump(),**changes})
        with self.assertRaises(ValidationError): Operation(kind='set',column_ids=['company'],assigned_value='A',similarity_method='sequence')

    def test_tool_preserves_requested_method_and_both_existing_output_ids(self):
        columns=[dict(column_id=id,header=id,role='reference') for id in ['company','group','score']]
        context={'workspace':{**self.workspace,'columns':columns,'target_column_ids':['company']}}
        tool=next(t for t in build_request_tools(context) if t.name=='match_suppliers')
        result=tool.invoke(dict(method='sequence',output=dict(mode='existing',column_id='group',score_column_id='score')))
        self.assertEqual(result['operation']['similarity_method'],'sequence')
        self.assertEqual(result['operation']['output']['score_column_id'],'score')
        self.assertEqual(result['operation']['condition']['operator'],'blank')
        with self.assertRaises(ValueError): tool.invoke(dict(output=dict(mode='existing',column_id='group',score_column_id='missing')))

    def test_partial_paired_write_recovery_is_bound_to_approved_columns_and_scope(self):
        self.source['operation'].update(similarity_method='sequence',output=dict(mode='existing',column_id='group',score_column_id='score'))
        self.create()
        preview=self.client.post(self.url('preview'),json={'selected_count':3,'rows':[{'excel_row':2,'values':['BAOSHAN']}]})
        self.assertEqual(preview.status_code,200,preview.text)
        self.client.post(self.url('status'),json={'status':'PREVIEW_READY'})
        wrong=self.client.post(self.url('apply'),json={'mode':'existing','column_id':'group','score_column_id':'other'})
        self.assertEqual(wrong.status_code,409)
        response=self.client.post(self.url('apply'),json={'mode':'existing','column_id':'group','score_column_id':'score'})
        self.assertEqual(response.status_code,200,response.text)
        job=self.app.state.operation_jobs[self.source['operation_job_id']]
        evidence=WriteEvidence(worksheet_id='sheet',table_id='table',identity_column_id='id',blocks=[
            dict(row_start=1,row_count=2,column_start=i+2,column_id=cid,before='a'*64,expected='b'*64,identities='c'*64)
            for i,cid in enumerate(['group','score'])])
        invalid=evidence.model_copy(deep=True);invalid.blocks[1].column_id='other'
        with self.assertRaises(ConflictError): validate_evidence(job,'operation',invalid)
        invalid=evidence.model_copy(deep=True);invalid.blocks[1].row_count=1
        with self.assertRaises(ConflictError): validate_evidence(job,'operation',invalid)
        invalid=evidence.model_copy(deep=True)
        for block in invalid.blocks:block.row_count=4
        with self.assertRaises(ConflictError): validate_evidence(job,'operation',invalid)
        save_evidence(job,'operation',evidence);job.status='UNKNOWN'
        result=recover(job,'operation',WriteObservation(values=['b'*64]*2,identities=['c'*64]*2,formulas=[False]*2))
        self.assertEqual(result['status'],'APPLIED');self.assertEqual(job.result_column_ids,['group','score'])


    def test_auto_keeps_first_pass_matches_and_only_runs_fallback_for_unmatched_unique_names(self):
        refs=[dict(group='앞',company_name='A'),dict(group='뒤',company_name='B')]
        values=['first','fallback','none','fallback','']
        rows=[Row(excel_row=i+2,values=[v]) for i,v in enumerate(values)]
        scores={'FIRST':{'levenshtein':[90,90],'sequence':[100,0]},
                'FALLBACK':{'levenshtein':[80,80],'sequence':[95,95]},
                'NONE':{'levenshtein':[70,80],'sequence':[60,65]}}
        with patch('services.supplier_matching.score',side_effect=lambda a,b,m:scores[a][m][['A','B'].index(b)]) as calculate:
            result=compare(rows,refs)
        self.assertEqual([r.values for r in result.rows],[['뒤','90'],['뒤','95'],['','65'],['뒤','95'],['','']])
        self.assertEqual(calculate.call_count,10)
        self.assertFalse(any(c.args[0]=='FIRST' and c.args[2]=='sequence' for c in calculate.call_args_list))

    def test_unspecified_job_method_and_tool_default_use_auto(self):
        self.conversation.investigation.conditions[0].target.company_name='JIANGSU SHAGANG INTERNATIONAL TRADE CO., LTD.'
        self.create()
        result=self.client.post(self.url('preview'),json={'rows':[{'excel_row':2,'values':['JIANGSU SHANGANG INTERNATIONALTRADE CO LTD']}]})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['rows'][0]['values'],['바오 스틸','94.252874'])
        context={'workspace':{**self.workspace,'columns':[dict(column_id='company',header='상호',role='reference')],'target_column_ids':['company']}}
        tool=next(t for t in build_request_tools(context) if t.name=='match_suppliers')
        self.assertEqual(tool.invoke({})['operation']['similarity_method'],'auto')
        self.assertEqual(tool.invoke({'method':'levenshtein'})['operation']['similarity_method'],'levenshtein')


    def test_existing_match_then_nonblank_conditional_update_preserves_threshold_and_target(self):
        from services.operations.jobs import CreateOperationJob, OperationJob, JobPreview, preview_job
        from services.operations.schemas import OperationRequest
        from services.operations.service import execute
        context={'workspace':{**self.workspace,'columns':[
            {'column_id':'company','header':'해외공급자상호 정제','role':'company_name'},
            {'column_id':'flag','header':'작업대상','role':'result'}], 'target_column_ids':['company']}}
        tools={tool.name:tool for tool in execution_tools(context,build_request_tools(context))}
        matching=tools['match_suppliers'].invoke({'column_id':'company','output':{'mode':'new','name':'이번 거래처 매칭'}})['operation']
        self.assertEqual(matching['similarity_method'],'auto')
        self.assertEqual(matching['output']['mode'],'new')
        job=OperationJob(source=CreateOperationJob(**(self.source|{'operation':matching})),
            supplier_references=[{'group':'대상 회사','company_name':'ABCDEFGHIJ'}])
        result=preview_job(job,JobPreview(rows=[{'excel_row':i+2,'values':[value]} for i,value in enumerate(
            ['ABCDEFGHIJ','ABCDEFGHIx','ABCDEFGHxx',''])]))
        self.assertEqual([row.values[0] for row in result.rows],['대상 회사','대상 회사','',''])
        context['workspace']['columns'] += [{'column_id':'matched-group','header':'이번 거래처 매칭','role':'result'}]
        tools={tool.name:tool for tool in execution_tools(context,build_request_tools(context))}
        update=tools['update_matching_rows'].invoke(dict(condition_column_id='matched-group',operator='not_blank',value='',
            destination_column_id='flag',assigned_value='Y',scope='current'))['operation']
        selected=[Row(excel_row=row.excel_row,values=[row.values[0]]) for row in result.rows if row.values[0]]
        changed=execute(OperationRequest(operation=update,rows=selected))
        self.assertEqual([(row.excel_row,row.values) for row in changed.rows],[(2,['Y']),(3,['Y'])])
        self.assertEqual(update['destination_column_id'],'flag');self.assertEqual(update['condition_scope'],'current')
        with self.assertRaises(ValidationError):
            OperationRequest(operation=update,rows=[{'excel_row':4,'values':['']}])

if __name__=='__main__': unittest.main()
