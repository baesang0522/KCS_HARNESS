import unittest
from uuid import uuid4
from pydantic import ValidationError
from agents.request_tools import build_request_tools
from services.operations.schemas import Operation, OperationRequest
from services.operations.jobs import CreateOperationJob, OperationJob, JobPreview, OutputPlacement, preview_job, begin_apply, operation_history_context
from services.errors import ConflictError


class ConditionalUpdateTests(unittest.TestCase):
    def operation(self, **override):
        return dict(kind='set', column_ids=['source'], assigned_value='재확인',
                    condition=dict(column_id='source', operator='contains', value='AB-12'),
                    destination_column_id='memo') | override

    def source(self, **override):
        return dict(operation_job_id=uuid4(), conversation_id=uuid4(), workspace_id=uuid4(),
                    worksheet_id='sheet', table_id='table', task_type='investigation', row_start=1,
                    row_count=3092, operation=self.operation(), row_filter=self.operation()['condition']) | override

    def test_tool_resolves_distinct_existing_columns_without_business_specific_roles(self):
        tools = {t.name:t for t in build_request_tools({'workspace':dict(columns=[
            dict(column_id='source',header='제품 설명',role='reference'),
            dict(column_id='memo',header='사용자 메모',role='reference')],target_column_ids=['memo'])})}
        args=dict(condition_column_id='source',operator='contains',value='AB-12',destination_column_id='memo',assigned_value='재확인')
        result=tools['update_matching_rows'].invoke(args)
        self.assertEqual(result['intent'],'operation')
        self.assertEqual(result['operation']['condition'],self.operation()['condition'])
        self.assertEqual(result['operation']['column_ids'],['source'])
        self.assertEqual(result['operation']['destination_column_id'],'memo')
        for override in [dict(condition_column_id='deleted'),dict(destination_column_id='invented'),dict(value='')]:
            with self.assertRaises(ValueError): tools['update_matching_rows'].invoke(args | override)

    def test_condition_and_destination_are_mandatory_together_and_cannot_be_attached_to_other_operations(self):
        for override in [dict(condition=None),dict(destination_column_id=None),dict(column_ids=['memo']),
                         dict(kind='replace',assigned_value=None)]:
            with self.assertRaises(ValidationError): Operation(**self.operation(**override))
        with self.assertRaises(ValidationError):
            CreateOperationJob(**self.source(operation=self.operation(condition_scope='all')))
        CreateOperationJob(**self.source(operation=self.operation(condition_scope='all'),row_filter=None))

    def test_server_checks_condition_and_destination_before_applying(self):
        job=OperationJob(source=CreateOperationJob(**self.source()))
        result=preview_job(job,JobPreview(selected_count=2,rows=[dict(excel_row=i,values=['AB-12 STEEL']) for i in [2,3093]]))
        self.assertEqual([r.excel_row for r in result.rows],[2,3093])
        self.assertEqual([r.values for r in result.rows],[['재확인'],['재확인']])
        with self.assertRaises(ValidationError):
            preview_job(job,JobPreview(selected_count=2,rows=[dict(excel_row=3,values=['OTHER'])]))
        job.status='PREVIEW_READY'
        for output in [dict(mode='existing',column_id='source'),dict(mode='new',anchor='memo')]:
            with self.assertRaises(ConflictError): begin_apply(job,OutputPlacement(**output))
        self.assertEqual(job.status,'PREVIEW_READY')
        begin_apply(job,OutputPlacement(mode='existing',column_id='memo'))
        self.assertEqual(job.status,'APPLYING')

    def test_literal_conditions_keep_case_and_spaces_and_support_clearing_same_column(self):
        cases=[('contains','AB','xABy','xabY'),('equals',' A ',' A ','A'),
               ('not_equals','A','B','A'),('blank','','  ','A'),('not_blank','','A','  ')]
        for operator,value,yes,no in cases:
            operation=self.operation(condition=dict(column_id='source',operator=operator,value=value),
                                     destination_column_id='source',assigned_value='')
            OperationRequest(operation=operation,rows=[dict(excel_row=2,values=[yes])])
            with self.assertRaises(ValidationError):
                OperationRequest(operation=operation,rows=[dict(excel_row=2,values=[no])])

    def test_scope_survives_tool_and_job_with_distinct_inherited_filter(self):
        workspace=dict(columns=[dict(column_id='source'),dict(column_id='memo')])
        tool=next(t for t in build_request_tools({'workspace':workspace}) if t.name=='update_matching_rows')
        args=dict(condition_column_id='source',operator='contains',value='AB-12',destination_column_id='memo',assigned_value='N')
        self.assertEqual(tool.invoke(args)['operation']['condition_scope'],'current')
        for scope in ['current','all']:
            result=tool.invoke(args | {'scope':scope})
            self.assertEqual(result['operation']['condition_scope'],scope)
            prior=dict(column_id='memo',operator='equals',value='Y') if scope=='current' else None
            job=OperationJob(source=CreateOperationJob(**self.source(operation=result['operation'],row_filter=prior)))
            self.assertEqual(job.source.row_filter.model_dump() if prior else None,prior)
            # The new condition is still validated even when the prior filter is a different column.
            with self.assertRaises(ValidationError):
                preview_job(job,JobPreview(selected_count=1,rows=[dict(excel_row=2,values=['OTHER'])]))
            preview_job(job,JobPreview(selected_count=1,rows=[dict(excel_row=2,values=['AB-12'])]))
            history_workspace=job.source.model_dump(include={'workspace_id','worksheet_id','table_id','task_type'})
            history_workspace['columns']=[dict(column_id='source',header='조건'),dict(column_id='memo',header='판정')]
            record=operation_history_context({'job':job},conversation_id=str(job.source.conversation_id),workspace=history_workspace)['records'][0]
            self.assertEqual(record['executed_range']['condition_scope'],scope)
            self.assertEqual(record['executed_range']['condition'],result['operation']['condition'])
            self.assertEqual(record['executed_range']['matching_row_count'],1)
            self.assertEqual(record['executed_range'].get('row_filter'),prior)
