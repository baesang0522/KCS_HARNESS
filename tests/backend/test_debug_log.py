import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage

from agents.request_graph import run_request_graph
from services.debug_log import log_event
from services.errors import MODEL_RESPONSE_ERROR


class DebugLogTests(unittest.IsolatedAsyncioTestCase):
    def events(self, output):
        return [json.loads(call.args[0]) for call in output.call_args_list]

    def runtime(self, *replies):
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=list(replies)))
        return SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a, **k: model), tools_prompt='test')

    def reply(self, name='ask_user', args=None, call_id='call-1'):
        return AIMessage(content='', tool_calls=[dict(name=name, args=args or {'question': '어느 열?'}, id=call_id)])

    def test_json_redaction_preserves_input_and_flushes(self):
        payload = {'API-Key': 'secret-value', 'nested': [{'password': 'private', 'values': ['한글\n두 줄']}]}
        with patch('builtins.print') as output:
            log_event('test', payload=payload)
        event = self.events(output)[0]
        self.assertEqual(event['payload']['API-Key'], '[REDACTED]')
        self.assertEqual(event['payload']['nested'][0]['password'], '[REDACTED]')
        self.assertEqual(event['payload']['nested'][0]['values'], ['한글\n두 줄'])
        self.assertEqual(payload['API-Key'], 'secret-value')
        self.assertTrue(output.call_args.kwargs['flush'])
        self.assertEqual(len(output.call_args.args[0].splitlines()), 1)

    def test_bulk_excel_data_is_counted_without_copying_values_to_logs(self):
        rows = [{'values': ['PRIVATE CELL'], 'excel_row': 2}] * 100000
        groups = [{'values': ['PRIVATE CODE', 'PRIVATE GROUP', '100'], 'count': 100000}]
        observation = {'kind': 'read', 'column_ids': ['2', '5', '6'],
                       'row_count': 100000, 'groups': groups}
        payload = {'receipt': {'rows': rows}, 'workspace': {'sample_rows': rows[:2]},
                   'observation': observation, 'read_results': [{'result': observation}],
                   'row_ids': list(range(100000))}
        with patch('builtins.print') as output:
            log_event('model.started', task_context=payload)
        printed = output.call_args.args[0]
        logged = self.events(output)[0]['task_context']
        self.assertLess(len(printed), 1500)
        self.assertNotIn('PRIVATE', printed)
        self.assertEqual(logged['receipt']['rows'], {'count': 100000, 'omitted': True})
        self.assertEqual(logged['observation']['groups'], {'count': 1, 'omitted': True})
        self.assertEqual(logged['workspace']['sample_rows'], {'count': 2, 'omitted': True})
        self.assertEqual(logged['row_ids'], {'count': 100000, 'omitted': True})
        self.assertEqual(logged['observation']['column_ids'], ['2', '5', '6'])
        self.assertEqual(logged['observation']['row_count'], 100000)
        self.assertIs(payload['receipt']['rows'], rows)
        self.assertEqual(rows[-1]['values'], ['PRIVATE CELL'])
        self.assertIs(payload['read_results'][0]['result']['groups'], groups)

    def test_column_id_types_and_validation_errors_remain_visible(self):
        arguments = {'column_ids': [2, 3, 5, 6]}
        errors = [{'type': 'string_type', 'loc': ['column_ids', 0], 'msg': 'Input should be a valid string'}]
        with patch('builtins.print') as output:
            log_event('tool.failed', arguments=arguments, error_message=errors, attempt=2, will_retry=False)
        logged = self.events(output)[0]
        self.assertEqual(logged['arguments'], arguments)
        self.assertEqual(logged['error_message'], errors)
        self.assertFalse(logged['will_retry'])

    async def test_success_records_input_result_timing_and_ids(self):
        context = {'api_key': 'private-value'}
        with patch('builtins.print') as output:
            result = await run_request_graph(self.runtime(self.reply()), [HumanMessage(content='사용자 요청')], context,
                                            log_context={'conversation_id': 'conv', 'request_id': 'req'})
        events = self.events(output)
        sizes = next(item for item in events if item['event'] == 'model.input_size')
        self.assertIn('context_section_chars', sizes)
        events = [item for item in events if item['event'] != 'model.input_size']
        self.assertEqual([item['event'] for item in events], ['model.started', 'model.completed', 'tool.started', 'tool.completed'])
        self.assertEqual(events[2]['arguments'], {'question': '어느 열?'})
        self.assertEqual(events[3]['result'], result)
        self.assertEqual(events[2]['tool_call_id'], 'call-1')
        self.assertEqual(events[3]['tool_name'], 'ask_user')
        self.assertGreaterEqual(events[3]['elapsed_ms'], 0)
        self.assertTrue(all(item['request_id'] == 'req' and item['conversation_id'] == 'conv' for item in events))
        self.assertEqual(len({item['graph_id'] for item in events}), 1)
        self.assertNotIn('private-value', str(output.call_args_list))

    async def test_validation_retry_keeps_attempts_and_both_call_ids(self):
        with patch('builtins.print') as output:
            result = await run_request_graph(self.runtime(self.reply(args={'question': []}), self.reply(call_id='call-2')), [], {})
        events = self.events(output)
        failed = next(item for item in events if item['event'] == 'tool.failed')
        self.assertTrue(failed['will_retry'])
        self.assertEqual(failed['error_type'], 'ValidationError')
        self.assertEqual(failed['tool_call_id'], 'call-1')
        self.assertEqual(events[-1]['tool_call_id'], 'call-2')
        self.assertEqual(events[-1]['attempt'], 2)
        self.assertEqual(result['intent'], 'clarify')

    async def test_unknown_tool_stops_retry_after_second_failure(self):
        with patch('builtins.print') as output:
            result = await run_request_graph(self.runtime(self.reply('unknown'), self.reply('unknown', call_id='call-2')), [], {})
        failures = [item for item in self.events(output) if item['event'] == 'tool.failed']
        self.assertEqual([item['will_retry'] for item in failures], [True, False])
        self.assertEqual(result['answer'], MODEL_RESPONSE_ERROR)

    async def test_unexpected_tool_error_is_logged_and_propagated(self):
        tool = SimpleNamespace(name='broken', ainvoke=AsyncMock(side_effect=RuntimeError('boom')))
        with patch('agents.request_graph.build_request_tools', return_value=[tool]), patch('builtins.print') as output:
            with self.assertRaisesRegex(RuntimeError, 'boom'):
                await run_request_graph(self.runtime(self.reply('broken')), [], {})
        event = self.events(output)[-1]
        self.assertEqual(event['event'], 'tool.failed')
        self.assertEqual(event['error_type'], 'RuntimeError')
        self.assertFalse(event['will_retry'])

    async def test_model_error_is_logged_and_propagated(self):
        with patch('builtins.print') as output:
            with self.assertRaisesRegex(TimeoutError, 'timeout'):
                await run_request_graph(self.runtime(TimeoutError('timeout')), [], {})
        self.assertEqual(self.events(output)[-1]['event'], 'model.failed')

    async def test_broken_stdout_does_not_break_the_tool(self):
        with patch('builtins.print', side_effect=BrokenPipeError):
            result = await run_request_graph(self.runtime(self.reply()), [], {})
        self.assertEqual(result['answer'], '어느 열?')
