import unittest
from uuid import uuid4
from pydantic import ValidationError
from agents.request_tools import build_request_tools
from agents.request_router import RequestDecision
from api.schemas import ChatResponse
from services.operations.schemas import RowFilter, CombinedRowFilter, ScopeRequest, WorkspaceContext
from services.operations.jobs import CreateOperationJob, OperationJob
from services.execution_history import execution_history_context


class ScopeDependenciesTests(unittest.TestCase):
    def workspace(self):
        return dict(workspace_id=uuid4(), worksheet_id='sheet', table_id='table', sheet_name='조사',
                    task_type='investigation', row_count=4, columns=[
                        dict(column_id=key, header=key, role='reference') for key in ['company','country','flag','result']],
                    row_filter=dict(column_id='flag', operator='equals', value='Y'))

    def combined(self):
        return dict(base=dict(column_id='flag',operator='equals',value='Y'), steps=[
            dict(mode='include',condition=dict(column_id='company',operator='equals',value='B')),
            dict(mode='exclude',condition=dict(column_id='country',operator='equals',value='CN'))],base_ids=None)

    def test_scope_tool_resolves_columns_and_returns_a_scope_action_without_operations(self):
        workspace=self.workspace()
        tool=next(tool for tool in build_request_tools({'workspace':workspace}) if tool.name=='change_scope')
        for mode in ['replace','include','exclude']:
            card=tool.invoke(dict(mode=mode,column_id='company',operator='equals',value='B'))
            decision=RequestDecision.model_validate(card)
            self.assertEqual(decision.scope_change.mode,mode)
            self.assertIsNone(decision.operation)
            ChatResponse(conversation_id='c',request_id='r',answer='범위 변경',reasoning=[],ui_action=dict(
                type='change_scope',workspace_id=workspace['workspace_id'],request=decision.scope_change,
                expected_filter=workspace['row_filter']))
        self.assertIsNone(tool.invoke(dict(mode='clear'))['scope_change']['condition'])
        for args in [dict(mode='include',column_id='missing',value='B'),dict(mode='include',column_id='company'),
                     dict(mode='clear',column_id='company'),dict(mode='exclude')]:
            with self.assertRaises((ValueError,ValidationError)):tool.invoke(args)
        with self.assertRaises(ValidationError):RequestDecision(intent='scope',answer='missing')
        with self.assertRaises(ValidationError):ScopeRequest(mode='clear',condition=workspace['row_filter'])

    def test_combined_scope_validates_every_column_including_nested_bounded_bases(self):
        simple=self.workspace()['row_filter']
        self.assertEqual(RowFilter(**simple).model_dump(),simple)
        scope=CombinedRowFilter(**self.combined())
        self.assertEqual(scope.column_ids,['flag','company','country'])
        nested=CombinedRowFilter(base=scope,steps=[dict(mode='include',condition=simple)],base_ids=[1,3])
        WorkspaceContext(**(self.workspace()|{'row_filter':nested}))
        invalid=self.combined();invalid['steps'][1]['condition']['column_id']='deleted'
        with self.assertRaises(ValidationError):WorkspaceContext(**(self.workspace()|{'row_filter':invalid}))
        for change in [dict(base_ids=[1,1]),dict(steps=[]),dict(steps=[dict(mode='wrong',condition=simple)])]:
            with self.assertRaises(ValidationError):CombinedRowFilter(**(self.combined()|change))

    def test_operation_jobs_keep_combined_scope_and_review_state_disables_stale_history_results(self):
        workspace=self.workspace();conversation_id=uuid4()
        job=OperationJob(source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=conversation_id,
            workspace_id=workspace['workspace_id'],worksheet_id='sheet',table_id='table',task_type='investigation',
            row_start=1,row_count=4,row_filter=self.combined(),operation=dict(kind='replace',column_ids=['company'],find='A',replacement='B')),
            status='APPLIED',result_column_ids=['result'])
        jobs={str(job.source.operation_job_id):job}
        history=execution_history_context(jobs,{},conversation_id=str(conversation_id),workspace=workspace)
        self.assertTrue(history['records'][0]['result_columns'][0]['can_continue'])
        workspace['review_required_column_ids']=['result']
        history=execution_history_context(jobs,{},conversation_id=str(conversation_id),workspace=workspace)
        self.assertTrue(history['records'][0]['needs_review'])
        self.assertFalse(history['records'][0]['result_columns'][0]['can_continue'])
        self.assertEqual(history['records'][0]['executed_range']['row_filter'],self.combined())
