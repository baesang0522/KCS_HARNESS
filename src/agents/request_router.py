import json
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, ConfigDict, Field


class RequestDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["general", "start_task", "clarify"]
    task_type: Literal["model_normalization", "counterparty_cleanup", "formula"] | None = None

    answer: str = Field(min_length=1, max_length=2000)


async def route_request(runtime, messages, request_id: str):
    result = await runtime.request_router_graph.ainvoke({
        "message": [
            HumanMessage(content=json.dumps(
                [
                    {"role": message.type,"content": message.content} for message in messages
                ],
                ensure_ascii=False,
            ))
        ],
        "request_id": request_id,
        "tool_history": [],
    })

    last = result["messages"][-1]

    if not (isinstance(last, AIMessage) or last.tool_calls or not isinstance(last.content, str)):
        raise ValueError("유효한 요청 분류 응답이 아닙니다.")

    decision = RequestDecision.model_validate_json(last.content.strip())

    if decision.intent == "start_task" and decision.task_type is None:
        raise ValueError("작업 요청에는 Task_type이 필요합니다.")
    if decision.intent != "start_task" and decision.task_type is not None:
        raise ValueError("작업 시작 외의 응답에는 task_type을 지정하지 않습니다.")
    return decision

