import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError
from services.formula.planner import parse_formula_plan
from services.formula.schemas import CreateFormulaJobRequest, FormulaJob
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
