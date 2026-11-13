import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage
from pydantic import ValidationError

from agents.request_tools import build_request_tools
from services.errors import ConflictError
from services.operations.jobs import (
    CreateOperationJob, JobPreview, JobUpdate, OperationJob, OutputPlacement,
    begin_apply, preview_job, update_job,
)
from services.operations.schemas import WorkspaceContext, Operation, OperationRequest, extraction_column_id
from services.operations.service import execute
from services.recommendation.schemas import AdviceRequest
from services.recommendation.service import resolve_advice_columns
from services.recommendation.analysis import generate_advice


class InvestigationTests(unittest.IsolatedAsyncioTestCase):
    def workspace(self):
        return dict(workspace_id=uuid4(), worksheet_id='sheet', table_id='table',
                    sheet_name='조사', task_type='investigation', row_count=100,
                    columns=[dict(column_id='custom', header='사용자 판단', role='reference')],
                    row_filter=dict(column_id='custom', operator='equals', value='Y'))

    def test_arbitrary_single_column_and_filter_need_no_business_roles(self):
        payload = self.workspace()
        context = WorkspaceContext.model_validate(payload)
        self.assertEqual(context.row_filter.column_id, 'custom')
        payload['row_filter']['column_id'] = 'deleted'
        with self.assertRaises(ValidationError):
            WorkspaceContext.model_validate(payload)
        payload['row_filter'] = None
        payload['task_type'] = 'counterparty_cleanup'
        with self.assertRaises(ValidationError):
            WorkspaceContext.model_validate(payload)

    def test_set_value_and_clear_value_preserve_physical_row_numbers(self):
        workspace = self.workspace()
        tools = {tool.name: tool for tool in build_request_tools({'workspace': workspace})}
        for value in ['확정', '']:
            card = tools['set_value'].invoke(dict(column_id='custom', value=value))
            result = execute(OperationRequest(operation=card['operation'], rows=[
                dict(excel_row=10, values=['기존']), dict(excel_row=70, values=['수정'])]))
            self.assertEqual([row.excel_row for row in result.rows], [10, 70])
            self.assertEqual([row.values for row in result.rows], [[value], [value]])
        with self.assertRaises(ValidationError):
            Operation(kind='set', column_ids=['custom'])

    def test_model_capabilities_follow_assigned_roles_in_unified_workspace(self):
        workspace = self.workspace()
        workspace['advice_subject'] = 'company'
        self.assertEqual(resolve_advice_columns(workspace, None), ['custom'])
        workspace['advice_subject'] = 'model'
        with self.assertRaises(ValueError):
            resolve_advice_columns(workspace, None)
        workspace['columns'] += [dict(column_id=role, header=role, role=role)
                                 for role in ['declared_name', 'trade_name', 'model_spec']]
        self.assertEqual(extraction_column_id(workspace), 'model_spec')
        self.assertEqual(resolve_advice_columns(workspace, ['custom']),
                         ['custom', 'declared_name', 'trade_name', 'model_spec'])

    def job(self, operation):
        return OperationJob(source=CreateOperationJob(
            operation_job_id=uuid4(), conversation_id=uuid4(), workspace_id=uuid4(),
            worksheet_id='sheet', table_id='table', task_type='investigation',
            row_start=1, row_count=100, operation=operation,
            row_filter=dict(column_id='custom', operator='equals', value='Y')))

    def test_filtered_group_requires_all_matching_rows_and_keeps_real_positions(self):
        job = self.job(dict(kind='group', column_ids=['company'], value_column_id='custom',
                            group_mode='first_non_empty'))
        rows = [dict(excel_row=10, values=['A', 'yes']), dict(excel_row=70, values=['A', ''])]
        result = preview_job(job, JobPreview(rows=rows, selected_count=2))
        self.assertEqual([row.values[0] for row in result.rows], ['yes', 'yes'])
        for count in [None, 3, 101]:
            with self.assertRaises(ValueError):
                preview_job(job, JobPreview(rows=rows, selected_count=count))
        with self.assertRaises(ValueError):
            preview_job(job, JobPreview(rows=[dict(excel_row=102, values=['A', 'yes'])], selected_count=1))

    def test_existing_output_can_be_input_but_must_be_the_approved_column(self):
        job = self.job(dict(kind='set', column_ids=['custom'], assigned_value='Y'))
        job.status = 'PREVIEW_READY'
        begin_apply(job, OutputPlacement(mode='existing', column_id='custom'))
        with self.assertRaises(ConflictError):
            update_job(job, JobUpdate(status='APPLIED', result_column_ids=['other']))
        self.assertEqual(update_job(job, JobUpdate(status='APPLIED', result_column_ids=['custom'])).status, 'APPLIED')

    def test_sparse_advice_validates_bounds_duplicates_and_selected_count(self):
        payload = dict(conversation_id=uuid4(), request_id=uuid4(), worksheet_id='sheet', table_id='table',
                       row_start=1, row_count=2, range_row_count=100, sparse=True, column_ids=['custom'],
                       rows=[dict(excel_row=10, values=['A']), dict(excel_row=70, values=['B'])])
        self.assertEqual(AdviceRequest(**payload).row_count, 2)
        for override in [dict(sparse=False), dict(range_row_count=None), dict(range_row_count=50),
                         dict(row_count=3), dict(rows=[payload['rows'][0]] * 2)]:
            with self.assertRaises(ValidationError):
                AdviceRequest(**(payload | override))

    async def test_unified_model_advice_aggregates_filtered_rows_once_with_scope_context(self):
        workspace = self.workspace()
        workspace['advice_subject'] = 'model'
        roles = ['declared_name', 'trade_name', 'model_spec']
        workspace['columns'] += [dict(column_id=role, header=role, role=role) for role in roles]
        requests = []

        async def invoke(messages):
            requests.append(json.loads(messages[-1].content))
            return AIMessage(content='{"findings": []}')

        payload = AdviceRequest(conversation_id=uuid4(), request_id=uuid4(), worksheet_id='sheet',
            table_id='table', row_start=1, row_count=2, sparse=True, range_row_count=100,
            column_ids=roles, rows=[dict(excel_row=row, values=['P', 'T', 'AB1']) for row in [10, 70]])
        await generate_advice(SimpleNamespace(advice_model=SimpleNamespace(ainvoke=invoke),
            recommendation_prompt='test'), '모델 검토', workspace, payload)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]['advice_subject'], 'model')
        self.assertEqual(requests[0]['row_filter'], workspace['row_filter'])
        self.assertEqual(requests[0]['rows'][0]['count'], 2)
        self.assertEqual(requests[0]['selection']['total_rows'], 2)
