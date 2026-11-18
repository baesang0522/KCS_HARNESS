import unittest
from uuid import uuid4
from pydantic import ValidationError
from agents.request_tools import build_request_tools
from services.operations.schemas import Operation, OperationRequest
from services.operations.jobs import CreateOperationJob, OperationJob, JobPreview, OutputPlacement, preview_job, begin_apply
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
        for condition in [None,dict(column_id='source',operator='equals',value='AB-12')]:
            with self.assertRaises(ValidationError): CreateOperationJob(**self.source(row_filter=condition))

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
