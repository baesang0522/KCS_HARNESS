"""해외거래처 후보 생성·모델 검토 회귀 확인."""
import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage

from main import app
from repositories.memory_conversation_repository import MemoryConversationRepository


class ReviewGraph:
    def __init__(self):
        self.calls = []
        self.invalid = False

    async def ainvoke(self, state, **kwargs):
        self.calls.append(state)
        candidates = json.loads(state["messages"][0].content)["candidates"]
        reviews = [{
            "group_id": candidate["group_id"],
            "decision": "SAME_HIGH_CONFIDENCE" if index == 0 else "LIKELY_DIFFERENT",
            "reason": "상호의 핵심 단어와 법인 표기를 비교했습니다.",
        } for index, candidate in enumerate(candidates)]
        if self.invalid:
            reviews[0]["group_id"] = "UNKNOWN"
        return {"messages": [AIMessage(content=json.dumps({"reviews": reviews}))]}


class CounterpartyContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.review = ReviewGraph()
        app.state.runtime = SimpleNamespace(
            settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)),
            counterparty_review_graph=self.review,
        )
        app.state.conversations = MemoryConversationRepository()
        app.state.jobs = {}
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )
        self.cid = (await self.client.post("/conversations")).json()["conversation_id"]

    async def asyncTearDown(self):
        await self.client.aclose()

    def payload(self, rows):
        return {
            "conversation_id": self.cid, "job_id": str(uuid4()),
            "worksheet_id": "sheet-1", "sheet_name": "Sheet1",
            "address": f"Sheet1!A1:C{len(rows) + 1}",
            "row_start": 0, "column_start": 0, "row_count": len(rows) + 1,
            "headers": ["OVCS_CONM", "OVCS_SGN", "OVCS_NAT_CD"],
            "mapping": {"company_name": 0, "party_code": 1, "country_code": 2},
            "rows": [{"cells": row} for row in rows],
        }

    async def test_same_country_candidates_and_model_review(self):
        payload = self.payload([
            ["MINH HOANG CO LTD", "VN-1", "VN"],
            ["MINH-HOANG CO., LTD.", "VN-2", "VN"],
            ["MINH HOANG CO LTD", "US-1", "US"],
            ["BETA TRADING COMPANY", "VN-3", "VN"],
            ["BETA TRADING COMPANI", "VN-4", "VN"],
        ])
        created = await self.client.post("/jobs", json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        groups = created.json()["candidate_groups"]
        self.assertEqual(len(groups), 2)
        self.assertTrue(all(group["country_code"] == "VN" for group in groups))

        path = "/jobs/" + payload["job_id"]
        reviewed = await self.client.post(
            path + "/analyze", params={"conversation_id": self.cid}
        )
        result = reviewed.json()
        self.assertEqual(result["status"], "REVIEW_READY")
        self.assertEqual(len(result["review_results"]), 2)
        self.assertEqual(len(result["final_candidates"]), 1)
        self.assertEqual(result["excluded_candidate_count"], 1)
        model_input = json.loads(self.review.calls[0]["messages"][0].content)
        self.assertNotIn("rows", model_input["candidates"][0])
        await self.client.post(path + "/analyze", params={"conversation_id": self.cid})
        self.assertEqual(len(self.review.calls), 1)

    async def test_no_total_row_cap_and_changed_model_ids_fail(self):
        rows = [["SAME COMPANY", "ONE", "VN"] for _ in range(1001)]
        payload = self.payload(rows)
        created = await self.client.post("/jobs", json=payload)
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["data_row_count"], 1001)

        payload = self.payload([
            ["MINH HOANG CO LTD", "VN-1", "VN"],
            ["MINH-HOANG CO., LTD.", "VN-2", "VN"],
        ])
        await self.client.post("/jobs", json=payload)
        self.review.invalid = True
        result = (await self.client.post(
            "/jobs/" + payload["job_id"] + "/analyze",
            params={"conversation_id": self.cid},
        )).json()
        self.assertEqual(result["status"], "REVIEW_FAILED")
        self.assertEqual(result["final_candidates"], [])

    async def test_conversation_and_mapping_validation(self):
        payload = self.payload([["A", "1", "VN"], ["A", "2", "VN"]])
        await self.client.post("/jobs", json=payload)
        path = "/jobs/" + payload["job_id"]
        self.assertEqual((await self.client.get(
            path, params={"conversation_id": str(uuid4())}
        )).status_code, 404)
        payload["job_id"] = str(uuid4())
        payload["mapping"]["country_code"] = 0
        self.assertEqual((await self.client.post(
            "/jobs", json=payload
        )).status_code, 422)


if __name__ == "__main__":
    unittest.main()
