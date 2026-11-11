import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from agents.request_router import route_request
from agents.request_tools import build_request_tools
from models.codex_adapter import CodexModel, OUTPUT_SCHEMA
from services.errors import MODEL_RESPONSE_ERROR


class CodexAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = {'workspace': {
            'task_type': 'model_normalization', 'target_column_ids': ['model'],
            'columns': [dict(column_id=id, header=name, role=role) for id, name, role in [
                ('trade', '거래품명', 'trade_name'), ('model', '모델규격명', 'model_spec'),
                ('cleaned', '모델규격명 정제', 'result')]],
        }}

    async def test_codex_uses_real_graph_validation_and_repairs_unknown_column(self):
        calls = []
        async def execute(prompt, schema):
            payload = json.loads(prompt.split('\n', 1)[1])
            calls.append(payload)
            self.assertIn('start_task', schema['properties']['name']['enum'])
            if len(calls) == 1:
                ids = ['trade', 'invented']
            else:
                self.assertEqual(payload['conversation'][-1]['role'], 'tool')
                previous = payload['conversation'][-2]['tool_calls'][0]
                self.assertEqual(payload['conversation'][-1]['tool_call_id'], previous['id'])
                self.assertIn('입력 오류', payload['conversation'][-1]['content'])
                ids = ['trade', 'cleaned']
            return dict(name='start_task', arguments=json.dumps(dict(task_type='formula', input_column_ids=ids)))
        model = CodexModel('test')
        model._execute = execute
        runtime = SimpleNamespace(model=model, tools_prompt='도구 하나 선택')
        decision, _ = await route_request(runtime, [HumanMessage(content='조건부 추출')], task_context=self.context)
        self.assertEqual(decision.formula_column_ids, ['trade', 'cleaned'])
        self.assertEqual(len(calls), 2)
        self.assertFalse(hasattr(model, '_tools'))

    async def test_repeated_invalid_columns_end_in_clarification(self):
        model = CodexModel('test')
        model._execute = AsyncMock(return_value=dict(name='start_task', arguments=json.dumps({
            'task_type': 'formula', 'input_column_ids': ['missing']})))
        decision, _ = await route_request(SimpleNamespace(model=model, tools_prompt='test'),
                                         [HumanMessage(content='요청')], task_context=self.context)
        self.assertEqual(decision.intent, 'clarify')
        self.assertEqual(decision.answer, MODEL_RESPONSE_ERROR)
        self.assertEqual(model._execute.await_count, 2)

    async def test_plain_json_responses_still_work_without_bound_tools(self):
        model = CodexModel('test')
        model._execute = AsyncMock(return_value={'answer': '{"actions": []}'})
        response = await model.ainvoke([SystemMessage(content='JSON 응답'), HumanMessage(content='요청')])
        self.assertEqual(json.loads(response.content), {'actions': []})
        self.assertEqual(model._execute.call_args.args[1], OUTPUT_SCHEMA)

    async def test_malformed_tool_arguments_never_execute(self):
        for arguments in ('{', '[]', 'null'):
            model = CodexModel('test')
            model._execute = AsyncMock(return_value={'name': 'ask_user', 'arguments': arguments})
            bound = model.bind_tools(build_request_tools({}))
            response = await bound.ainvoke([HumanMessage(content='요청')])
            self.assertFalse(response.tool_calls)
            self.assertEqual(len(response.invalid_tool_calls), 1)

    async def test_cli_contract_and_timeout_cleanup(self):
        async def start(*args, **kwargs):
            self.assertIn('--ephemeral', args)
            self.assertEqual(args[args.index('--sandbox') + 1], 'read-only')
            self.assertEqual(json.loads(Path(args[args.index('--output-schema') + 1]).read_text()), OUTPUT_SCHEMA)
            Path(args[args.index('--output-last-message') + 1]).write_text('{"answer":"ok"}')
            return SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'', b'')))
        model = CodexModel('test')
        with patch('models.codex_adapter.asyncio.create_subprocess_exec', side_effect=start):
            self.assertEqual((await model.ainvoke([HumanMessage(content='hi')])).content, 'ok')
        for error in (asyncio.TimeoutError(), asyncio.CancelledError()):
            process = SimpleNamespace(returncode=None, kill=lambda: setattr(process, 'returncode', -9),
                communicate=AsyncMock(side_effect=[error, (b'', b'')]))
            with patch('models.codex_adapter.asyncio.create_subprocess_exec', AsyncMock(return_value=process)):
                with self.assertRaises(type(error)):
                    await model.ainvoke([HumanMessage(content='hi')])
            self.assertEqual(process.returncode, -9)
            self.assertEqual(process.communicate.await_count, 2)
