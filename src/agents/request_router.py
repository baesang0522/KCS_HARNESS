from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models.llama_cpp import get_reasoning_content
from services.operations.schemas import Operation
from services.chat_state import TaskType


class RequestDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent: Literal["general", "start_task", "clarify", "task_followup", "operation"]
    task_type: TaskType | None = None
    operation: Operation | None = None
    answer: str = Field(min_length=1, max_length=8000)

    @model_validator(mode="after")
    def validate_decision(self):
        if not self.answer.strip():
            raise ValueError("답변이 비어 있습니다.")
        if (self.intent == "start_task") != (self.task_type is not None):
            raise ValueError("작업 시작에는 작업 종류가 필요합니다.")
        if (self.intent == "operation") != (self.operation is not None):
            raise ValueError("연산 요청에는 연산 설정이 필요합니다.")
        return self


async def route_request(runtime, messages, *, task_context: dict):
    response = await runtime.respond(runtime.request_prompt, {
        "conversation": [{"role": message.type, "content": message.content} for message in messages],
        "task_context": task_context,
    })
    decision = RequestDecision.model_validate_json(response.content.strip())
    workspace = task_context.get("workspace")
    if decision.operation:
        if not workspace:
            raise ValueError("먼저 필수 세 열을 지정해 작업을 시작하세요.")

        columns = {column["column_id"] for column in workspace["columns"]}
        if not set(decision.operation.input_column_ids) <= columns:
            raise ValueError("현재 작업 시트에 없는 열을 요청했습니다.")

    if decision.intent == "task_followup" and not (workspace or task_context.get("active_job")):
        raise ValueError("후속 질문을 연결할 현재 작업이 없습니다.")
    reasoning = get_reasoning_content(response)
    return decision, [reasoning] if reasoning else []
