import copy
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock

from langchain_core.messages import AIMessage
from pydantic import ValidationError
from services.recommendation.analysis import generate_advice
from services.recommendation.selection import top_model_combinations
from services.recommendation.schemas import AdviceRequest
from test_model_advice import MODEL_COLUMNS, model_data


class AdviceSelectionTests(unittest.IsolatedAsyncioTestCase):
    def payload(self):
        data = model_data([['note', f'ab{i}', 'paint', 'enamel'] for i in range(102)] +
                          [['other', 'AB101', 'PAINT', 'ENAMEL']] * 3)
        rows, scope = top_model_combinations(data, MODEL_COLUMNS)
        return {**data.model_dump(), 'rows': rows, 'selection': scope}

    def test_aggregated_and_full_requests_select_identical_data(self):
        payload = self.payload()
        data = AdviceRequest.model_validate(payload)
        rows, scope = top_model_combinations(data, MODEL_COLUMNS)
        self.assertEqual(rows, payload['rows'])
        self.assertEqual(scope, payload['selection'])
        self.assertEqual(len(rows), 100)
        self.assertEqual(scope['represented_rows'], 103)

    def test_400000_rows_with_extra_columns_only_uploads_100_rows(self):
        columns = MODEL_COLUMNS + [{'column_id': f'extra{i}', 'role': 'reference'} for i in range(6)]
        data = AdviceRequest(conversation_id=uuid4(), request_id=uuid4(), worksheet_id='sheet',
            table_id='table', row_start=1, row_count=400000,
            column_ids=[c['column_id'] for c in columns],
            rows=[{'excel_row': i+2, 'values': ['note', f'M{i}', 'paint', 'enamel'] + ['x']*6,
                   'count': 4000} for i in range(100)],
            selection={'mode': 'uppercase_top_combinations',
                       'group_column_ids': ['declared', 'trade', 'model'],
                       'total_rows': 400000, 'total_combinations': 100,
                       'selected_combinations': 100, 'represented_rows': 400000,
                       'additional_values': 'first_row_example_only'})
        rows, _ = top_model_combinations(data, columns)
        self.assertEqual(sum(row['count'] for row in rows), 400000)
        self.assertEqual(len(rows)*len(columns), 1000)

    async def test_selected_counts_reach_scan_and_verify_without_recounting(self):
        requests = []

        async def invoke(messages):
            payload = json.loads(messages[-1].content)
            requests.append(payload)
            if payload['stage'] == 'scan':
                answer = {'findings': [{'excel_rows': [payload['rows'][0]['excel_row']],
                                        'advice': '자주 등장하는 모델 표기를 확인하세요.'}]}
            else:
                answer = {'findings': payload['proposals']}
            return AIMessage(content=json.dumps(answer))

        data = AdviceRequest.model_validate(self.payload())
        result = await generate_advice(SimpleNamespace(advice_model=SimpleNamespace(ainvoke=invoke),
            recommendation_prompt='test'), '조언',
            {'task_type': 'model_normalization', 'columns': MODEL_COLUMNS}, data)
        scans = [p for p in requests if p['stage'] == 'scan']
        self.assertEqual(len(scans), 1)
        self.assertEqual(scans[0]['rows'][0]['count'], 4)
        self.assertEqual(len(scans[0]['rows']), 100)
        self.assertEqual(requests[-1]['stage'], 'verify')
        self.assertEqual(requests[-1]['rows'][0]['count'], 4)
        self.assertIn('빈도 상위 100개', result)
        self.assertIn('103행', result)

    def test_invalid_summary_rejected(self):
        mutations = [
            lambda p: p['selection'].update(total_rows=106),
            lambda p: p['selection'].update(represented_rows=104),
            lambda p: p['selection'].update(total_combinations=200),
            lambda p: p['selection'].update(selected_combinations=99),
            lambda p: p['selection'].update(group_column_ids=['model']*3),
            lambda p: p['rows'][0].update(count=None),
            lambda p: p['rows'][0].update(excel_row=1),
            lambda p: p['rows'].reverse(),
            lambda p: p['rows'][1].update(values=p['rows'][0]['values']),
            lambda p: p['rows'][1].update(excel_row=p['rows'][0]['excel_row']),
            lambda p: p.update(selection=None),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                payload = copy.deepcopy(self.payload())
                mutate(payload)
                with self.assertRaises(ValidationError):
                    AdviceRequest.model_validate(payload)

    async def test_wrong_roles_and_counterparty_summary_rejected_before_llm(self):
        payload = self.payload()
        payload['selection']['group_column_ids'] = ['extra', 'trade', 'model']
        data = AdviceRequest.model_validate(payload)
        with self.assertRaisesRegex(ValueError, '집계 기준'):
            top_model_combinations(data, MODEL_COLUMNS)
        model = SimpleNamespace(ainvoke=AsyncMock())
        with self.assertRaisesRegex(ValueError, '모델규격 정제'):
            await generate_advice(SimpleNamespace(advice_model=model, recommendation_prompt='test'),
                '조언', {'task_type': 'counterparty_cleanup', 'columns': MODEL_COLUMNS},
                AdviceRequest.model_validate(self.payload()))
        model.ainvoke.assert_not_called()
