"""API 회귀 확인. 실제 Excel, LLM, DB에 접속하지 않는다.

프로젝트 루트: PYTHONPATH=src .venv/bin/python -B -m unittest discover -s tests -v
"""
import asyncio
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage

from main import app
from repositories.memory_conversation_repository import MemoryConversationRepository


class FakeGraph:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, state, **kwargs):
        self.calls.append(state)
        if isinstance(self.content, BaseException):
            raise self.content
        return {"messages": [*state["messages"], AIMessage(content=self.content)]}


class ApiContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = SimpleNamespace(
            settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1),
                                     agent=SimpleNamespace(max_iterations=5)),
            inspection_graph=FakeGraph("표본 분석 결과"),
            request_router_graph=FakeGraph(json.dumps({
                "intent": "general", "task_type": None, "answer": "일반 질문"})),
            chat_graph=FakeGraph("답변"),
        )
        app.state.runtime = self.runtime
        app.state.conversations = MemoryConversationRepository()
        app.state.jobs = {}
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.cid = (await self.client.post("/conversations")).json()["conversation_id"]
        self.job = {
            "conversation_id": self.cid, "job_id": str(uuid4()),
            "worksheet_id": "sheet-1", "sheet_name": "Sheet1", "address": "Sheet1!A1:C3",
            "row_start": 0, "column_start": 0, "row_count": 3,
            "headers": ["모델규격", "거래품명", "신고품명"],
            "mapping": {"trade_name": 1, "declared_name": 2, "model_spec": 0},
            "samples": [{"cells": ["  AB-100   220V  ", "펌프", "원심펌프"]},
                        {"cells": ["00123", "센서", "센서"]}],
        }
        self.path = "/jobs/" + self.job["job_id"]
        self.rules = {"rules": [{"operation": "trim"}, {"operation": "collapse_whitespace"}]}

    async def asyncTearDown(self):
        await self.client.aclose()

    async def create_job(self):
        response = await self.client.post("/jobs", json=self.job)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_job_analysis_preview_and_followup(self):
        created = await self.create_job()
        self.assertEqual(created["status"], "CREATED")
        self.assertEqual((await self.client.post(self.path + "/preview", json=self.rules)).status_code, 409)
        analyzed = await self.client.post(self.path + "/analyze")
        self.assertEqual(analyzed.json()["status"], "REVIEW_READY")
        await self.client.post(self.path + "/analyze")
        self.assertEqual(len(self.runtime.inspection_graph.calls), 1)
        source = json.loads(self.runtime.inspection_graph.calls[0]["messages"][0].content)
        self.assertEqual(source["samples"][0]["거래품명"], "펌프")
        self.assertEqual(source["samples"][0]["excel_row"], 2)
        preview = (await self.client.post(self.path + "/preview", json=self.rules)).json()
        self.assertEqual(preview["changed_count"], 1)
        self.assertEqual(preview["rows"][0]["normalized_model_spec"], "AB-100 220V")
        self.assertEqual(preview["rows"][1]["normalized_model_spec"], "00123")
        self.assertEqual(preview["rows"][0]["original_model_spec"], "  AB-100   220V  ")
        self.assertEqual(preview["rows"][0]["applied_operations"], ["trim", "collapse_whitespace"])
        conv = (await self.client.get("/conversations/" + self.cid)).json()
        self.assertEqual(conv["workflow"]["active_job_id"], self.job["job_id"])
        self.runtime.request_router_graph.content = json.dumps({"intent": "task_followup", "task_type": None, "answer": "후속"})
        answer = await self.client.post("/chat", json={"conversation_id": self.cid, "request_id": str(uuid4()), "message": "어떻게 정제해?"})
        self.assertEqual(answer.status_code, 200, answer.text)
        context = json.loads(self.runtime.chat_graph.calls[0]["messages"][-2].content)
        self.assertEqual(context["task_context"]["active_job"]["analysis"], "표본 분석 결과")

    async def test_retry_validation_and_missing(self):
        first = await self.create_job()
        self.assertEqual(await self.create_job(), first)
        other = dict(self.job, address="Sheet1!A2:C4")
        self.assertEqual((await self.client.post("/jobs", json=other)).status_code, 409)
        bad = dict(self.job, mapping={"trade_name": 0, "declared_name": 0, "model_spec": 2})
        self.assertEqual((await self.client.post("/jobs", json=bad)).status_code, 422)
        self.assertEqual((await self.client.post(self.path + "/preview", json={"rules": [{"operation": "remove_voltage"}]})).status_code, 422)
        self.assertEqual((await self.client.get("/jobs/" + str(uuid4()))).status_code, 404)
        missing = await self.client.get("/conversations/" + str(uuid4()))
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["detail"], "대화가 없습니다. 새 대화를 시작하세요.")

    async def test_chat_retry_and_selection_action(self):
        self.runtime.request_router_graph.content = json.dumps({"intent": "start_task", "task_type": "model_normalization", "answer": "범위를 선택하세요."})
        payload = {"conversation_id": self.cid, "request_id": str(uuid4()), "message": "모델규격 정제"}
        first = await self.client.post("/chat", json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["ui_action"], {"type": "confirm_selection", "task_type": "model_normalization"})
        self.assertEqual((await self.client.post("/chat", json=payload)).json(), first.json())
        self.assertEqual(len(self.runtime.request_router_graph.calls), 1)
        self.assertEqual((await self.client.post("/chat", json=dict(payload, message="다른 질문"))).status_code, 409)
        conv = (await self.client.get("/conversations/" + self.cid)).json()
        self.assertEqual(conv["workflow"]["phase"], "WAITING_SELECTION")
        self.assertEqual(len(conv["messages"]), 2)

    async def test_general_chat_and_failure(self):
        payload = {"conversation_id": self.cid, "request_id": str(uuid4()), "message": "안녕"}
        first = await self.client.post("/chat", json=payload)
        self.assertEqual(first.json()["answer"], "답변")
        self.assertIsNone(first.json()["ui_action"])
        self.assertEqual((await self.client.post("/chat", json=payload)).json(), first.json())
        self.runtime.chat_graph.content = RuntimeError("test failure")
        with self.assertLogs(level="ERROR"):
            failed = await self.client.post("/chat", json=dict(payload, request_id=str(uuid4())))
        self.assertEqual(failed.status_code, 502)
        conv = (await self.client.get("/conversations/" + self.cid)).json()
        self.assertEqual(len(conv["messages"]), 2)

    async def test_analysis_failure_and_cancellation(self):
        await self.create_job()
        self.runtime.inspection_graph.content = RuntimeError("test failure")
        with self.assertLogs(level="ERROR"):
            failed = await self.client.post(self.path + "/analyze")
        self.assertEqual(failed.json()["status"], "FAILED")
        self.runtime.inspection_graph.content = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.client.post(self.path + "/analyze")
        self.assertEqual((await self.client.get(self.path)).json()["status"], "FAILED")

    async def test_route_contract(self):
        schema = (await self.client.get("/openapi.json")).json()
        self.assertEqual(set(schema["paths"]), {"/health", "/chat", "/conversations", "/conversations/{conversation_id}", "/jobs", "/jobs/{job_id}", "/jobs/{job_id}/analyze", "/jobs/{job_id}/preview"})
        self.assertEqual(schema["paths"]["/jobs/{job_id}/preview"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"], "#/components/schemas/NormalizationPreview")


if __name__ == "__main__":
    unittest.main()
