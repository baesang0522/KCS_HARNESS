import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
from fastapi import FastAPI
from langchain_core.messages import AIMessage

from api.chat import router
from api.errors import service_error_response
from repositories.conversation_repository import (
    ConversationNotFound, MemoryConversationRepository, StoredTurn,
)
from services.errors import ServiceError
from services.recommendation.analysis import generate_advice
from test_model_advice import MODEL_COLUMNS, model_data


class AdviceBatchTests(unittest.IsolatedAsyncioTestCase):
    async def run_advice(self, model, data=None, progress=None):
        return await generate_advice(
            SimpleNamespace(advice_model=model, recommendation_prompt='test'), '조언',
            {'task_type': 'model_normalization', 'columns': MODEL_COLUMNS},
            data or model_data([['note', f'M{i}', 'paint', 'enamel'] for i in range(100)]),
            progress=progress,
        )

    async def test_eight_proposals_are_verified_together_with_unique_evidence(self):
        requests, stages = [], []
        findings = [{'excel_rows': [2, i + 3], 'advice': f'제안 {i}'} for i in range(8)]

        async def invoke(messages):
            payload = json.loads(messages[-1].content)
            requests.append(payload)
            # 검증에서 근거가 약한 제안을 제외하고 나머지를 수정할 수 있다.
            result = findings if payload['stage'] == 'scan' else [
                {**finding, 'advice': '검증 완료 ' + finding['advice']} for finding in findings[:2]
            ]
            return AIMessage(content=json.dumps({'findings': result}))

        answer = await self.run_advice(SimpleNamespace(ainvoke=invoke), progress=stages.append)
        self.assertEqual([r['stage'] for r in requests], ['scan', 'verify'])
        self.assertEqual(len(requests[0]['rows']), 100)
        self.assertEqual(requests[1]['proposals'], findings)
        self.assertEqual([r['excel_row'] for r in requests[1]['rows']], list(range(2, 11)))
        self.assertIn('1/2', stages[0])
        self.assertIn('2/2', stages[1])
        self.assertIn('제안 8개 전체', stages[1])
        self.assertIn('검증 완료 제안 1', answer)
        self.assertNotIn('제안 2', answer)

    async def test_no_proposals_skips_verification(self):
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content='{"findings":[]}')))
        answer = await self.run_advice(model)
        self.assertEqual(model.ainvoke.await_count, 1)
        self.assertIn('확정하지 못했습니다', answer)

    async def test_verification_can_reject_every_proposal(self):
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[
            AIMessage(content='{"findings":[{"excel_rows":[2],"advice":"후보"}]}'),
            AIMessage(content='{"findings":[]}'),
        ]))
        answer = await self.run_advice(model)
        self.assertEqual(model.ainvoke.await_count, 2)
        self.assertIn('확정하지 못했습니다', answer)

    async def test_scan_and_verify_reject_unprovided_evidence(self):
        for stage in ('scan', 'verify'):
            replies = [AIMessage(content='{"findings":[{"excel_rows":[999],"advice":"잘못된 근거"}]}')]
            if stage == 'verify':
                replies.insert(0, AIMessage(content='{"findings":[{"excel_rows":[2],"advice":"후보"}]}'))
            with self.subTest(stage=stage), self.assertRaises(ValueError):
                await self.run_advice(SimpleNamespace(ainvoke=AsyncMock(side_effect=replies)))

    async def test_oversized_top_100_fails_without_splitting_or_model_call(self):
        model = SimpleNamespace(ainvoke=AsyncMock())
        data = model_data([['가' * 500, f'M{i}', 'paint', 'enamel'] for i in range(100)])
        with self.assertRaisesRegex(ValueError, '한 번에 보낼 수 있는 입력 크기'):
            await self.run_advice(model, data)
        model.ainvoke.assert_not_called()


class AdviceProgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.add_exception_handler(ServiceError, service_error_response)
        self.app.add_exception_handler(ConversationNotFound, service_error_response)
        self.repo = self.app.state.conversations = MemoryConversationRepository()
        self.app.state.formula_jobs = {}
        self.data = model_data([['note', 'M1', 'paint', 'enamel']])
        self.cid = await self.repo.create()
        payload = self.data.model_dump(mode='json')
        payload['conversation_id'] = self.cid
        self.payload = payload
        self.rid = payload['request_id']
        self.turn = StoredTurn(
            request_id=self.rid, question='의견', answer='준비', reasoning=[],
            ui_action={'type': 'analyze_data', 'column_ids': self.data.column_ids},
            request_context={'task_type': 'model_normalization', 'columns': MODEL_COLUMNS,
                             'worksheet_id': 'sheet', 'table_id': 'table'},
        )
        async with self.repo.edit(self.cid) as conversation:
            await conversation.save_turn(self.turn)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        self.progress_url = f'/conversations/{self.cid}/requests/{self.rid}/recommendation-progress'

    async def asyncTearDown(self):
        await self.client.aclose()

    def model(self, invoke):
        self.app.state.runtime = SimpleNamespace(
            advice_model=SimpleNamespace(ainvoke=invoke), recommendation_prompt='test',
        )

    async def progress(self):
        response = await asyncio.wait_for(self.client.get(self.progress_url), timeout=1)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['message']

    async def test_progress_is_readable_while_analysis_holds_lock_and_after_completion(self):
        started = {stage: asyncio.Event() for stage in ('scan', 'verify')}
        release = {stage: asyncio.Event() for stage in ('scan', 'verify')}

        async def invoke(messages):
            payload = json.loads(messages[-1].content)
            stage = payload['stage']
            started[stage].set()
            await release[stage].wait()
            return AIMessage(content='{"findings":[{"excel_rows":[2],"advice":"표기를 확인하세요"}]}')

        self.model(invoke)
        self.assertIn('준비', await self.progress())
        running = asyncio.create_task(self.client.post('/chat/recommendation', json=self.payload))
        try:
            for stage, label in [('scan', '1/2'), ('verify', '2/2')]:
                await asyncio.wait_for(started[stage].wait(), timeout=1)
                self.assertIn(label, await self.progress())
                release[stage].set()
            response = await asyncio.wait_for(running, timeout=1)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn('완료', await self.progress())
            # 같은 요청 재시도는 저장된 결과를 반환한다.
            self.model(AsyncMock(side_effect=AssertionError('must not call model again')))
            repeated = await self.client.post('/chat/recommendation', json=self.payload)
            self.assertEqual(response.json(), repeated.json())
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)

    async def test_failure_and_unknown_requests_have_correct_status(self):
        self.model(AsyncMock(side_effect=ValueError('입력 크기 초과')))
        response = await self.client.post('/chat/recommendation', json=self.payload)
        self.assertGreaterEqual(response.status_code, 400)
        self.assertIn('실패', await self.progress())
        self.assertEqual((await self.client.get(self.progress_url.replace(self.rid, str(uuid4())))).status_code, 404)
        self.assertEqual((await self.client.get(self.progress_url.replace(self.cid, str(uuid4())))).status_code, 404)

    async def test_cancel_stops_analysis_and_updates_progress(self):
        started = asyncio.Event()

        async def invoke(messages):
            started.set()
            await asyncio.Event().wait()

        self.model(invoke)
        running = asyncio.create_task(self.client.post('/chat/recommendation', json=self.payload))
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            cancelled = await self.client.post(f'/conversations/{self.cid}/requests/{self.rid}/cancel')
            self.assertEqual(cancelled.status_code, 200)
            response = await asyncio.wait_for(running, timeout=1)
            self.assertEqual(response.status_code, 409)
            self.assertIn('중지', await self.progress())
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
