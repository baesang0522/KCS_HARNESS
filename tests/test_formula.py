import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

import httpx
from langchain_core.messages import AIMessage

from main import app
from repositories.memory_conversation_repository import MemoryConversationRepository


class FormulaGraph:
    def __init__(self, formula="=A2+10"):
        self.formula = formula
        self.raw_content = None
        self.calls = []

    async def ainvoke(self, state, **kwargs):
        self.calls.append(state)
        content = json.dumps({
            "version": 1,
            "summary": "A열 값에 10을 더합니다.",
            "actions": [{
                "target_range": "B2:B4",
                "anchor_cell": "B2",
                "formula": self.formula,
                "mode": "fill_down",
                "overwrite": "reject_nonblank",
            }],
            "warnings": [],
        })
        return {"messages": [AIMessage(content=self.raw_content or content)]}


class FormulaContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.graph = FormulaGraph()
        app.state.runtime = SimpleNamespace(
            settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)),
            formula_graph=self.graph,
        )
        app.state.conversations = MemoryConversationRepository()
        app.state.jobs = {}
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )
        self.cid = (await self.client.post("/conversations")).json()["conversation_id"]
        self.job_id = str(uuid4())
        self.payload = {
            "task_type": "formula",
            "conversation_id": self.cid,
            "job_id": self.job_id,
            "instruction": "A열 값에 10을 더해서 B열에 넣어줘",
            "worksheet_id": "sheet-1",
            "sheet_name": "Sheet1",
            "address": "Sheet1!A2:A4",
            "row_start": 1,
            "column_start": 0,
            "row_count": 3,
            "column_count": 1,
            "samples": [{"cells": ["1"]}, {"cells": ["2"]}, {"cells": ["3"]}],
            "sheet_context": {
                "address": "Sheet1!A1:F4",
                "row_start": 0,
                "column_start": 0,
                "row_count": 4,
                "column_count": 6,
                "samples": [
                    {"cells": ["상품코드", "상품명", "단가", "재고", "", ""]},
                    {"cells": ["P001", "볼트", "100", "0", "", ""]},
                ],
            },
        }

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_plan_approve_and_complete(self):
        created = await self.client.post("/jobs", json=self.payload)
        self.assertEqual(created.status_code, 200, created.text)
        path = "/jobs/" + self.job_id
        planned = await self.client.post(path + "/analyze")
        self.assertEqual(planned.status_code, 200, planned.text)
        result = planned.json()
        self.assertEqual(result["status"], "PREVIEW_READY")
        preview = result["preview"]
        self.assertEqual(preview["plan"]["actions"][0]["formula"], "=A2+10")

        wrong_rows = await self.client.post(
            path + "/previews/" + preview["preview_id"] + "/approve",
            json={"target_range": "C3:C5"},
        )
        self.assertEqual(wrong_rows.status_code, 409)

        approved = await self.client.post(
            path + "/previews/" + preview["preview_id"] + "/approve",
            json={"target_range": "C2:C4"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(
            approved.json()["plan"]["actions"][0]["target_range"],
            "C2:C4",
        )
        completed = await self.client.post(
            path + "/previews/" + preview["preview_id"] + "/complete"
        )
        self.assertEqual(completed.json()["status"], "APPLIED")
        model_input = json.loads(self.graph.calls[0]["messages"][0].content)
        self.assertEqual(model_input["instruction"], self.payload["instruction"])
        self.assertEqual(
            model_input["sheet_context"]["samples"][0]["cells"][3], "재고",
        )

    async def test_next_formula_receives_previous_plan_and_conversation(self):
        await self.client.post("/jobs", json=self.payload)
        await self.client.post("/jobs/" + self.job_id + "/analyze")

        second_id = str(uuid4())
        second = dict(
            self.payload,
            job_id=second_id,
            instruction="재고가 0이면 판매불가로 바꿔서 다시 적용해줘",
        )
        await self.client.post("/jobs", json=second)
        result = await self.client.post("/jobs/" + second_id + "/analyze")
        self.assertEqual(result.json()["status"], "PREVIEW_READY")

        model_input = json.loads(self.graph.calls[-1]["messages"][0].content)
        context = model_input["context"]
        self.assertEqual(
            context["previous_instruction"], self.payload["instruction"],
        )
        self.assertEqual(
            context["previous_plan"]["actions"][0]["formula"], "=A2+10",
        )
        self.assertEqual(len(context["previous_plans"]), 1)
        self.assertEqual(
            context["previous_plans"][0]["plan"]["actions"][0]["output_label"],
            "결과",
        )

    async def test_external_formula_is_rejected(self):
        self.graph.formula = '=HYPERLINK("https://example.com","열기")'
        await self.client.post("/jobs", json=self.payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        self.assertEqual(result["status"], "FAILED")
        self.assertIsNone(result["preview"])

    async def test_lookup_formula_keeps_explicit_ranges(self):
        self.graph.formula = "=IFERROR(VLOOKUP(I2,$A$2:$F$13,4,FALSE),'미등록')"
        payload = dict(
            self.payload,
            job_id=str(uuid4()),
            instruction="I열 상품코드를 상품 마스터 A2:F13에서 찾아 상품명을 넣어줘",
            address="Sheet1!I2:I4",
            column_start=8,
        )
        await self.client.post("/jobs", json=payload)
        result = (await self.client.post(
            "/jobs/" + payload["job_id"] + "/analyze"
        )).json()
        self.assertEqual(
            result["preview"]["plan"]["actions"][0]["formula"],
            '=IFERROR(VLOOKUP(I2,$A$2:$F$13,4,FALSE),"미등록")',
        )

    async def test_lookup_table_ranges_are_made_absolute(self):
        self.graph.formula = '=XLOOKUP(I2,A2:A13,B2:B13,"")'
        payload = dict(
            self.payload,
            address="Sheet1!I2:I4",
            column_start=8,
            instruction="상품코드로 상품명을 찾아줘",
        )
        await self.client.post("/jobs", json=payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        self.assertEqual(
            result["preview"]["plan"]["actions"][0]["formula"],
            '=XLOOKUP(I2,$A$2:$A$13,$B$2:$B$13,"")',
        )

    async def test_ambiguous_request_returns_one_clarification(self):
        self.graph.raw_content = json.dumps({
            "version": 1,
            "summary": "비교할 현재 수량 열을 확인해야 합니다.",
            "actions": [],
            "clarification": "비교할 현재 수량은 어느 열인가요?",
            "warnings": [],
        })
        await self.client.post("/jobs", json=self.payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        self.assertEqual(result["status"], "NEEDS_INPUT")
        self.assertEqual(result["clarification"], "비교할 현재 수량은 어느 열인가요?")

    async def test_multiple_formula_actions_are_approved_together(self):
        self.graph.raw_content = json.dumps({
            "version": 1,
            "summary": "재고를 조회하고 현재 수량과 비교합니다.",
            "actions": [
                {
                    "target_range": "B2:B4", "anchor_cell": "B2",
                    "formula": '=XLOOKUP(A2,$D$2:$D$4,$E$2:$E$4,"")',
                    "output_label": "재고 수량", "mode": "fill_down",
                    "overwrite": "reject_nonblank",
                },
                {
                    "target_range": "C2:C4", "anchor_cell": "C2",
                    "formula": '=IF(B2="","",B2-F2)',
                    "output_label": "재고 차이", "mode": "fill_down",
                    "overwrite": "reject_nonblank",
                },
            ],
            "clarification": None,
            "warnings": [],
        })
        payload = dict(self.payload, instruction="상품 재고를 찾고 현재 수량과 비교해줘")
        await self.client.post("/jobs", json=payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        preview = result["preview"]
        self.assertEqual(len(preview["plan"]["actions"]), 2)
        approved = await self.client.post(
            "/jobs/" + self.job_id + "/previews/" + preview["preview_id"] + "/approve",
            json={"target_ranges": ["B2:B4", "C2:C4"]},
        )
        self.assertEqual(approved.status_code, 200, approved.text)

    async def test_product_plan_without_source_key_is_rejected(self):
        self.graph.formula = '=IF(E2="","",E2-F2)'
        payload = dict(self.payload, instruction="상품 재고 수량을 채워줘")
        await self.client.post("/jobs", json=payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        self.assertEqual(result["status"], "FAILED")

    async def test_unescaped_quotes_inside_formula_json_are_repaired(self):
        self.graph.raw_content = '''{
          "version": 1,
          "summary": "조회",
          "actions": [{
            "target_range": "O2:O13",
            "anchor_cell": "O2",
            "formula": "=IFERROR(VLOOKUP(I2,$A$2:$F$13,4,FALSE),"미등록")",
            "mode": "fill_down",
            "overwrite": "reject_nonblank"
          }],
          "warnings": []
        }'''
        await self.client.post("/jobs", json=self.payload)
        result = (await self.client.post(
            "/jobs/" + self.job_id + "/analyze"
        )).json()
        self.assertEqual(result["status"], "PREVIEW_READY")
        self.assertEqual(
            result["preview"]["plan"]["actions"][0]["formula"],
            '=IFERROR(VLOOKUP(I2,$A$2:$F$13,4,FALSE),"미등록")',
        )


if __name__ == "__main__":
    unittest.main()
