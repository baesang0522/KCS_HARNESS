import json
import unittest
from unittest.mock import patch

import httpx
from openai import AsyncOpenAI

from runtime import create_runtime
from settings import Settings


class InternalThinkingTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_internal_models_send_thinking_disabled_and_keep_output_budgets(self):
        settings = Settings(environment='internal', llm=dict(
            provider='openai_compatible', model='internal-test', base_url='http://model.test/v1',
            max_tokens=2048, advice_max_tokens=8192))
        with patch('runtime.load_settings', return_value=settings):
            runtime = create_runtime()
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json=dict(id='test', object='chat.completion', created=0,
                model='internal-test', choices=[dict(index=0, finish_reason='stop',
                message=dict(role='assistant', content='{}'))]))

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            async with AsyncOpenAI(base_url='http://model.test/v1', api_key='test', http_client=http) as client:
                for model in (runtime.model, runtime.advice_model):
                    model.async_client = client.chat.completions
                    await model.ainvoke('test')
        self.assertEqual(len(requests), 2)
        for request, budget in zip(requests, (2048, 8192)):
            self.assertIs(request['chat_template_kwargs']['enable_thinking'], False)
            self.assertEqual(request['max_tokens'], budget)
            self.assertEqual(request['reasoning_format'], 'deepseek')
