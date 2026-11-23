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

    def test_explicit_overwrite_survives_approval_but_source_overlap_stays_blocked(self):
        from services.formula.schemas import FormulaApprovalRequest, FormulaJob, FormulaPreview, FormulaPlan
        from services.formula.service import approve_preview
        source=CreateFormulaJobRequest(task_type='formula', conversation_id=uuid4(), formula_job_id=uuid4(),
            instruction='기존 결과 열을 갱신', worksheet_id='sheet', sheet_name='Sheet1', address='Sheet1!A2:A3037',
            row_start=1, column_start=0, row_count=3036, column_count=1, samples=[{'cells':['89']}])
        preview=FormulaPreview(plan=FormulaPlan(version=1, summary='계산', actions=[
            FormulaAction(target_range='B2:B3037',anchor_cell='B2',formula='=IF(A2<90,"N","Y")',mode='fill_down')]))
        job=FormulaJob(source=source,status='PREVIEW_READY',preview=preview)
        jobs={str(source.formula_job_id):job}
        with self.assertRaisesRegex(ValueError,'원본 선택 범위'):
            approve_preview(source.formula_job_id,preview.preview_id,FormulaApprovalRequest(target_ranges=['A2:A3037'],overwrite='allow'),jobs)
        self.assertEqual(job.status,'PREVIEW_READY')
        approved=approve_preview(source.formula_job_id,preview.preview_id,
            FormulaApprovalRequest(target_ranges=['C2:C3037'],overwrite='allow'),jobs)
        self.assertEqual(approved.plan.actions[0].overwrite,'allow')
        self.assertEqual(approved.plan.actions[0].target_range,'C2:C3037')
        self.assertEqual(FormulaApprovalRequest(target_ranges=['C2:C3037']).overwrite,'reject_nonblank')
