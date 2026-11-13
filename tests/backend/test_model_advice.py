import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from langchain_core.messages import AIMessage, HumanMessage

from agents.request_graph import run_request_graph
from repositories.conversation_repository import MemoryConversationRepository
from services.chat import process_chat
from services.errors import MODEL_RESPONSE_ERROR, ModelProcessingError
from services.recommendation.analysis import generate_advice
from services.recommendation.model_io import ask, batches, byte_size
from services.recommendation.selection import top_model_combinations
from services.recommendation.schemas import AdviceRequest, Review
from services.recommendation.service import resolve_advice_columns, resolve_columns


MODEL_COLUMNS = [
    {'column_id': 'extra', 'role': 'reference', 'header': '설명', 'description': '참고 정보'},
    {'column_id': 'model', 'role': 'model_spec', 'header': '모델규격명'},
    {'column_id': 'declared', 'role': 'declared_name', 'header': '신고품명'},
    {'column_id': 'trade', 'role': 'trade_name', 'header': '거래품명'},
]


def model_data(values):
    return AdviceRequest(conversation_id=uuid4(), request_id=uuid4(),
                         worksheet_id='sheet', table_id='table', row_start=1,
                         row_count=len(values), column_ids=[c['column_id'] for c in MODEL_COLUMNS],
                         rows=[{'excel_row': i + 2, 'values': row} for i, row in enumerate(values)])


class ModelAdviceTests(unittest.IsolatedAsyncioTestCase):
    def test_uppercase_grouping_uses_three_roles_and_preserves_originals(self):
        data = model_data([
            ['first', 'ab123', 'paint', 'enamel'],
            ['different', 'AB123', 'PAINT', 'ENAMEL'],
            ['third', ' AB123', 'paint', 'enamel'],
            ['fourth', 'ab123', 'other', 'enamel'],
            ['fifth', 'ab123', 'paint', 'other'],
            ['', '', '', ''],
        ])
        original = data.model_dump()
        rows, scope = top_model_combinations(data, MODEL_COLUMNS)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0], {'excel_row': 2, 'count': 2,
                                  'values': ['FIRST', 'AB123', 'PAINT', 'ENAMEL']})
        self.assertEqual(scope['represented_rows'], 6)
        self.assertEqual(scope['total_combinations'], 5)
        self.assertEqual(scope['group_column_ids'], ['declared', 'trade', 'model'])
        self.assertEqual(data.model_dump(), original)

    def test_top_100_frequency_and_stable_ties(self):
        values = [['note', f'AB{i}', 'paint', 'enamel'] for i in range(502)]
        values.extend([['different', 'ab501', 'PAINT', 'ENAMEL']] * 3)
        rows, scope = top_model_combinations(model_data(values), MODEL_COLUMNS)
        self.assertEqual(len(rows), 100)
        self.assertEqual(rows[0]['values'][1], 'AB501')
        self.assertEqual(rows[0]['count'], 4)
        self.assertEqual(rows[-1]['values'][1], 'AB98')
        self.assertEqual(scope['total_combinations'], 502)
        self.assertEqual(scope['represented_rows'], 103)
        self.assertEqual(scope['total_rows'], 505)

    def test_advice_adds_grouping_keys_without_changing_other_column_selection(self):
        workspace = {'task_type': 'model_normalization', 'columns': MODEL_COLUMNS}
        selected = ['extra']
        self.assertEqual(resolve_advice_columns(workspace, selected),
                         ['extra', 'declared', 'trade', 'model'])
        self.assertEqual(resolve_columns(workspace, selected), ['extra'])
        self.assertEqual(selected, ['extra'])
        with self.assertRaises(ValueError):
            top_model_combinations(model_data([['x', 'a1', 'p', 't']]), MODEL_COLUMNS[:2])

    async def test_model_advice_only_sends_top_100_uppercase_combinations(self):
        requests = []

        async def invoke(messages):
            request = json.loads(messages[-1].content)
            requests.append(request)
            if request['stage'] == 'scan':
                reply = {'findings': [{'excel_rows': [request['rows'][0]['excel_row']],
                                       'advice': '추출 후보를 확인하세요.'}]}
            elif request['stage'] == 'merge':
                reply = request['reviews'][0]
            else:
                reply = {'findings': request['proposals']}
            return AIMessage(content=json.dumps(reply, ensure_ascii=False))

        values = [['note', f'ab{i}', 'paint', 'enamel'] for i in range(502)]
        values.extend([['different', 'AB501', 'PAINT', 'ENAMEL']] * 3)
        data = model_data(values)
        expected, scope = top_model_combinations(data, MODEL_COLUMNS)
        result = await generate_advice(SimpleNamespace(
            advice_model=SimpleNamespace(ainvoke=invoke), recommendation_prompt='test'),
            '정제 의견', {'task_type': 'model_normalization', 'columns': MODEL_COLUMNS}, data)
        self.assertEqual([r['stage'] for r in requests], ['scan', 'verify'])
        self.assertEqual(requests[0]['rows'], expected)
        self.assertTrue(all(r['selection'] == scope for r in requests))
        verified = [row for r in requests if r['stage'] == 'verify' for row in r['rows']]
        self.assertTrue(verified)
        self.assertTrue(all(row in expected for row in verified))
        self.assertIn('빈도 상위 100개', result)
        self.assertIn('103행', result)
        self.assertNotIn('전체 505행의 원문', result)

    def test_scan_batches_cover_all_rows_and_boundary_pairs(self):
        for count in (0, 1, 99, 100, 101, 199, 200, 250):
            rows = list(range(count))
            parts = list(batches(rows, 24000, overlap=True, max_items=100))
            self.assertTrue(all(len(part) <= 100 for part in parts))
            self.assertEqual({x for part in parts for x in part}, set(rows))
            pairs = {(a, b) for part in parts for a, b in zip(part, part[1:])}
            self.assertEqual(pairs, set(zip(rows, rows[1:])))

    def test_byte_limit_and_merge_behavior_are_preserved(self):
        rows = [str(i) + '가' * 40 for i in range(10)]
        parts = list(batches(rows, 300, overlap=True, max_items=100))
        self.assertTrue(all(byte_size(part) <= 300 for part in parts))
        self.assertTrue(all(len(part) < 100 for part in parts))
        self.assertEqual({x for part in parts for x in part}, set(rows))
        self.assertEqual(len(list(batches(list(range(150)), 24000))), 1)
        with self.assertRaises(ValueError):
            list(batches(['가' * 1000], 300, max_items=100))

    async def test_invalid_model_calls_return_friendly_clarification(self):
        replies = [
            AIMessage(content='이상한 출력'),
            AIMessage(content='', invalid_tool_calls=[
                {'name': 'ask_user', 'args': '{', 'id': 'broken', 'error': 'bad json'}]),
            AIMessage(content='', tool_calls=[
                {'name': 'unknown_tool', 'args': {}, 'id': 'unknown'}]),
            AIMessage(content='', tool_calls=[
                {'name': 'ask_user', 'args': {'question': ''}, 'id': 'invalid'}]),
            AIMessage(content='', tool_calls=[
                {'name': 'ask_user', 'args': {'question': '확인'}, 'id': str(i)}
                for i in range(2)]),
        ]
        for reply in replies:
            model = SimpleNamespace(ainvoke=AsyncMock(
                side_effect=lambda *args: reply.model_copy(update={"id": None})))
            runtime = SimpleNamespace(
                model=SimpleNamespace(bind_tools=lambda *a, **k: model), tools_prompt='test')
            result = await run_request_graph(runtime, [HumanMessage(content='요청')], {})
            self.assertEqual(result['answer'], MODEL_RESPONSE_ERROR)
            self.assertEqual(result['intent'], 'clarify')
            self.assertIsNone(result['operation'])

    async def test_chat_exception_has_friendly_message_and_does_not_save_turn(self):
        repo = MemoryConversationRepository()
        cid = await repo.create()
        with patch('services.chat.route_request', new=AsyncMock(side_effect=ValueError('bad output'))):
            with self.assertRaisesRegex(ModelProcessingError, MODEL_RESPONSE_ERROR):
                await process_chat(runtime=None, repository=repo, formula_jobs={},
                                   operation_jobs={}, conversation_id=cid,
                                   request_id=str(uuid4()), message='요청')
        async with repo.edit(cid) as conversation:
            self.assertEqual(conversation.turns, [])

    async def test_bad_advice_json_retries_then_friendly_message(self):
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content='잘못된 JSON')))
        with self.assertRaisesRegex(ValueError, MODEL_RESPONSE_ERROR):
            await ask(model, 'test', 'scan', {}, Review)
        self.assertEqual(model.ainvoke.await_count, 2)

    async def test_output_token_limit_is_still_distinguishable(self):
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(
            content='', response_metadata={'finish_reason': 'length'})))
        with self.assertRaisesRegex(ValueError, '토큰 한도'):
            await ask(model, 'test', 'scan', {}, Review)

    async def test_counterparty_advice_scans_every_row_once_then_merges(self):
        requests = []

        async def invoke(messages):
            request = json.loads(messages[-1].content)
            requests.append(request)
            stage = request['stage']
            if stage == 'scan':
                reply = {'findings': [{'excel_rows': [request['rows'][0]['excel_row']],
                                       'advice': '모델명을 확인하세요.'}]}
            elif stage == 'merge':
                reply = request['reviews'][0]
            else:
                reply = {'findings': request['proposals']}
            return AIMessage(content=json.dumps(reply, ensure_ascii=False))

        rows = [{'excel_row': i + 1, 'values': [f'AB{250-i}', f'설명 {i}']}
                for i in range(250)]
        data = AdviceRequest(conversation_id=uuid4(), request_id=uuid4(),
                             worksheet_id='sheet', table_id='table', row_start=0,
                             row_count=250, column_ids=['model', 'description'], rows=rows)
        workspace = {'task_type': 'counterparty_cleanup', 'columns': [
            {'column_id': 'model', 'header': '모델규격명', 'description': '모델 원문'},
            {'column_id': 'description', 'header': '설명', 'description': '참고 내용'},
        ]}
        result = await generate_advice(SimpleNamespace(
            advice_model=SimpleNamespace(ainvoke=invoke), recommendation_prompt='test'),
            '전체 데이터 정제 의견', workspace, data)
        scans = [r for r in requests if r['stage'] == 'scan']
        self.assertEqual([len(r['rows']) for r in scans], [100, 100, 52])
        received = {row['excel_row']: row for r in scans for row in r['rows']}
        self.assertEqual(received, {row['excel_row']: row for row in rows})
        self.assertTrue(all(r['columns'] == workspace['columns'] for r in scans))
        self.assertNotIn('plan', [r['stage'] for r in requests])
        self.assertEqual(sum(r['stage'] == 'verify' for r in requests), 1)
        self.assertIn('merge', [r['stage'] for r in requests])
        self.assertIn('verify', [r['stage'] for r in requests])
        self.assertIn('전체 250행', result)


if __name__ == '__main__':
    unittest.main()
