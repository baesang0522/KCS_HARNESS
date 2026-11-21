import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from pydantic import ValidationError
from services.formula.planner import parse_formula_plan, generate_formula_plan
from services.formula.schemas import CreateFormulaJobRequest, FormulaJob, FormulaPreview
from services.formula.service import plan_formula_job


def plan(mismatched=False):
    action = dict(target_range='B2:B3093', anchor_cell='B2',
                  formula='=IF(EXACT(A2,"JIANGSU SHAGANG INTL TRADE"),"Y","N")',
                  mode='fill_down', output_label='분석대상')
    actions = [action]
    if mismatched:
        actions.append(dict(target_range='C2:C3092', anchor_cell='C2', formula='=A2', mode='fill_down'))
    return dict(version=1, summary='회사별 표시', actions=actions, clarification=None, warnings=[])


class FormulaPlanValidationTests(unittest.TestCase):
    def test_3092_row_single_formula_plan_is_valid(self):
        result = parse_formula_plan(json.dumps(plan()))
        self.assertEqual(len(result.actions), 1)
        self.assertEqual(result.actions[0].target_range, 'B2:B3093')

    def test_mismatched_rows_are_not_repaired_as_bad_json(self):
        raw = json.dumps(plan(True))
        with patch('services.formula.planner.json.dumps', side_effect=AssertionError('must not repair valid JSON')):
            with self.assertRaisesRegex(ValidationError, '복수 결과 범위의 행'):
                parse_formula_plan(raw)

    def test_unescaped_formula_quotes_can_still_be_repaired(self):
        raw = json.dumps(plan()).replace('\\"', '"')
        result = parse_formula_plan(raw)
        self.assertEqual(result.actions[0].formula, plan()['actions'][0]['formula'])


class FormulaPlanErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_row_mismatch_reports_model_error_without_preview(self):
        source = CreateFormulaJobRequest(task_type='formula', conversation_id=uuid4(), formula_job_id=uuid4(),
            instruction='분석대상 열에 같은 회사는 Y 나머지는 N', worksheet_id='sheet', sheet_name='Sheet1',
            address='Sheet1!A2:A3093', row_start=1, column_start=0, row_count=3092, column_count=1,
            samples=[{'cells':['JIANGSU SHAGANG INTL TRADE']}])
        job = FormulaJob(source=source)
        async def respond(*args):
            return SimpleNamespace(content=json.dumps(plan(True)))
        runtime = SimpleNamespace(respond=respond, formula_prompt='test', settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))
        with self.assertLogs('services.formula.service', level='ERROR'):
            result = await plan_formula_job(source.formula_job_id, {str(source.formula_job_id):job}, runtime)
        self.assertEqual(result['status'], 'FAILED')
        self.assertIsNone(result['preview'])
        self.assertIn('시작·끝 행', result['error'])
        self.assertIn('AI가 만든', result['error'])
        self.assertNotIn('구체적으로', result['error'])


class FormulaPlanRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.source = CreateFormulaJobRequest(task_type='formula', conversation_id=uuid4(), formula_job_id=uuid4(),
            origin_request_id=uuid4(), workspace_id=uuid4(), table_id='table', workspace_task_type='investigation', instruction='거래처검토 회사명과 일치하면 Y 아니면 N인 분석대상 열을 만들어줘',
            worksheet_id='sheet', sheet_name='Sheet1', address='Sheet1!A2:A3093',
            row_start=1, column_start=0, row_count=3092, column_count=1,
            input_columns=[dict(column_id='supplier', column_index=0, header='해외공급자 상호', role='company_name')],
            samples=[{'cells':['ACME']}], reference_sheets=[dict(worksheet_id='reference', sheet_name='거래처검토',
                address='거래처검토!A1:B10', row_start=0, column_start=0, row_count=10, column_count=2,
                samples=[{'cells':['그룹','회사명']}])])
        self.valid = plan()
        self.valid['actions'][0]['formula'] = "=IF(COUNTIF('거래처검토'!$B$2:$B$10,A2)>0,\"Y\",\"N\")"
        self.runtime = SimpleNamespace(respond=AsyncMock(), formula_prompt='test',
                                       settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))

    def responses(self, *values):
        self.runtime.respond.side_effect = [SimpleNamespace(content=json.dumps(value) if isinstance(value, dict) else value)
                                           for value in values]

    async def test_trailing_prose_is_regenerated_with_same_inputs_and_correlated_errors(self):
        self.responses(json.dumps(self.valid)+'\n\n그건 정상임', self.valid)
        with patch('services.formula.planner.log_event') as log:
            result = await generate_formula_plan(self.source, None, self.runtime)
        self.assertEqual(result.actions[0].formula, self.valid['actions'][0]['formula'])
        self.assertEqual(self.runtime.respond.await_count, 2)
        first = self.runtime.respond.call_args_list[0].args[1]
        second = self.runtime.respond.call_args_list[1].args[1]
        self.assertEqual({k:v for k,v in second.items() if k != 'validation_errors'}, first)
        self.assertEqual(second['validation_errors'][0]['type'], 'json_invalid')
        self.assertNotIn('input', second['validation_errors'][0])
        event = log.call_args.kwargs
        self.assertEqual(event['job_id'], str(self.source.formula_job_id))
        self.assertEqual(event['origin_request_id'], str(self.source.origin_request_id))
        self.assertEqual(event['attempt'], 1)
        self.assertTrue(event['will_retry'])

    async def test_schema_output_bounds_and_unknown_sheet_errors_are_revalidated(self):
        invalid = [plan(True), json.loads(json.dumps(self.valid)), json.loads(json.dumps(self.valid))]
        invalid[1]['actions'][0].update(target_range='B2:B4000')
        invalid[2]['actions'][0]['formula'] = "='없는시트'!B2&A2"
        for value in invalid:
            with self.subTest(value=value):
                self.runtime.respond.reset_mock()
                self.responses(value, self.valid)
                result = await generate_formula_plan(self.source, None, self.runtime)
                self.assertEqual(result.actions[0].target_range, 'B2:B3093')
                self.assertEqual(self.runtime.respond.await_count, 2)
                self.assertTrue(self.runtime.respond.call_args.args[1]['validation_errors'])

    async def test_two_bad_responses_leave_no_stale_preview_or_approval(self):
        previous = FormulaPreview(plan=parse_formula_plan(json.dumps(self.valid)))
        job = FormulaJob(source=self.source, status='FAILED', preview=previous)
        self.responses(json.dumps(self.valid)+'\n\n설명', json.dumps(self.valid)+'\n\n설명')
        with self.assertLogs('services.formula.service', level='ERROR'), patch('services.formula.planner.log_event') as log:
            result = await plan_formula_job(self.source.formula_job_id, {str(self.source.formula_job_id):job}, self.runtime)
        self.assertEqual(self.runtime.respond.await_count, 2)
        self.assertEqual(result['status'], 'FAILED')
        self.assertIsNone(result['preview'])
        self.assertIsNone(result['approved_preview_id'])
        self.assertIn('JSON', result['error'])
        self.assertFalse(log.call_args.kwargs['will_retry'])

    async def test_clarification_and_valid_plan_are_not_retried(self):
        for value, status in [(self.valid, 'PREVIEW_READY'),
                              [dict(version=1, summary='확인', actions=[], clarification='조회 열을 알려줘'), 'NEEDS_INPUT']]:
            self.runtime.respond.reset_mock()
            self.responses(value)
            job = FormulaJob(source=self.source)
            result = await plan_formula_job(self.source.formula_job_id, {str(self.source.formula_job_id):job}, self.runtime)
            self.assertEqual(result['status'], status)
            self.assertEqual(self.runtime.respond.await_count, 1)
            self.assertIsNone(result['approved_preview_id'])

    async def test_transport_failure_and_cancellation_are_not_retried(self):
        for error in [RuntimeError('connection lost'), TimeoutError(), asyncio.CancelledError()]:
            self.runtime.respond.reset_mock()
            self.runtime.respond.side_effect = error
            with self.assertRaises(type(error)):
                await generate_formula_plan(self.source, None, self.runtime)
            self.assertEqual(self.runtime.respond.await_count, 1)

    async def test_retry_shares_the_original_timeout_budget(self):
        actual_timeout = asyncio.timeout
        async def respond(*args):
            await asyncio.sleep(0.02)
            return SimpleNamespace(content=json.dumps(self.valid))
        self.runtime.respond.side_effect = [SimpleNamespace(content='invalid')]
        async def first_then_slow(*args):
            if self.runtime.respond.await_count == 1:
                return SimpleNamespace(content='invalid')
            return await respond(*args)
        self.runtime.respond.side_effect = first_then_slow
        with patch('services.formula.planner.asyncio.timeout', side_effect=lambda seconds: actual_timeout(0.01)) as limit:
            with self.assertRaises(TimeoutError):
                await generate_formula_plan(self.source, None, self.runtime)
        limit.assert_called_once_with(11)
        self.assertEqual(self.runtime.respond.await_count, 2)
