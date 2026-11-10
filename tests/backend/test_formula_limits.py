import unittest
from uuid import uuid4

from pydantic import ValidationError
from services.formula.schemas import CreateFormulaJobRequest, FormulaAction


class FormulaLimitsTests(unittest.TestCase):
    def test_fill_down_accepts_large_ranges_up_to_excel_boundary(self):
        for rows in (10001, 90000, 400001, 1048576):
            with self.subTest(rows=rows):
                source = CreateFormulaJobRequest(
                    task_type='formula', conversation_id=uuid4(), formula_job_id=uuid4(),
                    instruction='행별 합산', worksheet_id='sheet', sheet_name='Sheet1',
                    address=f'Sheet1!A1:B{rows}', row_start=0, column_start=0,
                    row_count=rows, column_count=2, samples=[{'cells': ['1', '2']}])
                action = FormulaAction(target_range=f'C1:C{rows}', anchor_cell='C1',
                                       formula='=A1+B1', mode='fill_down')
                self.assertEqual(source.row_count, rows)
                self.assertEqual(action.target_range, f'C1:C{rows}')

    def test_excel_boundaries_and_action_shape_remain_enforced(self):
        for target, anchor, mode in [('C1:C1048577', 'C1', 'fill_down'),
                                     ('XFE1', 'XFE1', 'single'),
                                     ('C1:D100000', 'C1', 'fill_down'),
                                     ('C1:C100000', 'C1', 'single'),
                                     ('C1:C100000', 'C2', 'fill_down')]:
            with self.subTest(target=target, anchor=anchor, mode=mode):
                with self.assertRaises(ValidationError):
                    FormulaAction(target_range=target, anchor_cell=anchor,
                                  formula='=A1', mode=mode)
        with self.assertRaises(ValidationError):
            CreateFormulaJobRequest(task_type='formula', conversation_id=uuid4(),
                formula_job_id=uuid4(), instruction='행별 계산', worksheet_id='sheet',
                sheet_name='Sheet1', address='A2:A1048577', row_start=1, column_start=0,
                row_count=1048576, column_count=1, samples=[{'cells': ['1']}])
