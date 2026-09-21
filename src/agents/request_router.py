import json
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, ConfigDict, Field, field_validator


class RequestDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["general", "start_task", "clarify", "task_followup"]
    task_type: Literal["model_normalization", "counterparty_cleanup", "formula"] | None = None

    answer: str = Field(min_length=1, max_length=2000)

    @field_validator("task_type", mode="before")
    @classmethod
    def normalize_null_task_type(cls, value):
        if isinstance(value, str) and value.strip().lower() in {"null", "none"}:
            return None
        return value


async def route_request(
    runtime,
    messages,
    request_id: str,
    *,
    task_context: dict,
):
    # 분류 단계에는 전체 표본 대신 작업 상태와 분석 요약만 전달한다.
    active_job = task_context.get("active_job")
    routing_context = {
        "pending_intent": task_context.get("pending_intent"),
        "task_type": task_context.get("task_type"),
        "phase": task_context.get("phase"),
        "job_missing": task_context.get("job_missing", False),
        "active_job": None,
    }

    if active_job is not None:
        analysis = active_job.get("analysis", "")

        routing_context["active_job"] = {
            "job_id": active_job["job_id"],
            "task_type": active_job["task_type"],
            "status": active_job["status"],
            "address": active_job["address"],
            "analysis": analysis[:3000],
            "plan": active_job.get("plan"),
            "analysis_truncated": (
                active_job.get("analysis_truncated", False)
                or len(analysis) > 3000
            ),
        }

    result = await runtime.request_router_graph.ainvoke({
        "messages": [
            HumanMessage(content=json.dumps(
                {
                    "conversation": [
                        {
                            "role": message.type,
                            "content": message.content,
                        }
                        for message in messages
                    ],
                    "task_context": routing_context,
                },
                ensure_ascii=False,
            ))
        ],
        "request_id": request_id,
        "tool_history": [],
    })

    output_messages = result.get("messages", [])

    if not output_messages:
        raise ValueError("요청 분류 응답이 없습니다.")

    last = output_messages[-1]

    if (
        not isinstance(last, AIMessage)
        or last.tool_calls
        or not isinstance(last.content, str)
    ):
        raise ValueError("유효한 요청 분류 응답이 아닙니다.")

    decision = RequestDecision.model_validate_json(
        last.content.strip()
    )

    if decision.intent == "start_task":
        if decision.task_type is None:
            raise ValueError("작업 요청에는 task_type이 필요합니다.")

    elif decision.task_type is not None:
        raise ValueError(
            "작업 시작 외의 응답에는 task_type을 지정하지 않습니다."
        )

    if decision.intent == "task_followup" and active_job is None:
        raise ValueError("후속 질문을 연결할 현재 작업이 없습니다.")

    return decision
