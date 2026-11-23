import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError
from agents.request_tools import build_request_tools
from agents.request_graph import run_request_graph
from services.operations.schemas import OperationOutput
from services.formula.schemas import FormulaOutput


class OutputValidationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context={'workspace': {'columns': [dict(column_id=k,header=k,role='company_name' if k=='company' else 'reference')
                          for k in ['company','group','score']], 'target_column_ids':['company'], 'row_count':100000}}
        self.tools={t.name:t for t in build_request_tools(self.context)}

    def test_serialized_object_is_equivalent_to_native_object_and_keeps_existing_pair(self):
        for output in [dict(mode='new',name='거래처 그룹',anchor='company'),
                       dict(mode='existing',column_id='group',score_column_id='score')]:
            with self.subTest(output=output):
                normal=self.tools['match_suppliers'].invoke(dict(output=output))
                encoded=self.tools['match_suppliers'].invoke(dict(output=json.dumps(output)))
                self.assertEqual(normal,encoded)
                self.assertEqual(encoded['operation']['similarity_method'],'auto')
        self.assertIsNone(self.tools['match_suppliers'].invoke({})['operation']['output'])
        self.assertEqual(FormulaOutput.model_validate('{"mode":"new","name":"계산"}').name,'계산')

    async def test_new_shorthand_creates_new_columns_without_retry(self):
        expected = self.tools['match_suppliers'].invoke(dict(output={'mode': 'new'}))
        for output in ['new', ' new ']:
            with self.subTest(output=output):
                self.assertEqual(self.tools['match_suppliers'].invoke(dict(output=output)), expected)
        self.assertEqual(FormulaOutput.model_validate('new').mode, 'new')
        message = AIMessage(content='', tool_calls=[dict(name='match_suppliers', args=dict(output='new'), id='1')])
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=message))
        runtime = SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a, **k: model), tools_prompt='test')
        with patch('builtins.print'):
            result = await run_request_graph(runtime, [], self.context)
        self.assertEqual(result['intent'], 'operation')
        self.assertEqual(result['operation']['output']['mode'], 'new')
        model.ainvoke.assert_awaited_once()

    def test_malformed_outputs_are_not_guessed_or_silently_dropped(self):
        for output in ['existing','null','[]','"new"',[],1,True,'{"mode":"existing"}',
                       '{"mode":"existing","column_id":"missing"}',
                       '{"mode":"existing","column_id":"company"}',
                       '{"mode":"new","unexpected":true}']:
            with self.subTest(output=output),self.assertRaises(ValueError):
                self.tools['match_suppliers'].invoke(dict(output=output))
        with self.assertRaises(ValidationError):
            OperationOutput.model_validate('{"mode":"existing","column_id":"group","score_column_id":"group"}')

    def test_shared_output_contract_supports_other_operations(self):
        output='{"mode":"new","anchor":"company","name":"정제"}'
        result=self.tools['replace_text'].invoke(dict(column_id='company',find='A',replacement='B',output=output))
        self.assertEqual(result['operation']['output']['name'],'정제')

    async def test_graph_explains_field_and_recovers_on_second_call(self):
        def reply(output,call_id):
            return AIMessage(content='',tool_calls=[dict(name='match_suppliers',args=dict(output=output),id=call_id)])
        model=SimpleNamespace(ainvoke=AsyncMock(side_effect=[reply('existing','1'),reply({'mode':'new'},'2')]))
        runtime=SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a,**k:model),tools_prompt='test')
        with patch('builtins.print'):
            result=await run_request_graph(runtime,[],self.context)
        self.assertEqual(result['intent'],'operation')
        feedback=[m.content for m in model.ainvoke.call_args.args[0] if isinstance(m,ToolMessage)]
        self.assertIn('output:',feedback[-1]);self.assertIn('{"mode":"new"}',feedback[-1])
        model.ainvoke=AsyncMock(side_effect=[reply([],'3'),reply([],'4')])
        with patch('builtins.print'):
            failed=await run_request_graph(runtime,[],self.context)
        self.assertEqual(failed['intent'],'clarify');self.assertIn('저장 위치 설정',failed['answer'])
        self.assertNotIn('이해하지',failed['answer'])
