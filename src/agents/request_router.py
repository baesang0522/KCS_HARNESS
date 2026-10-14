from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, model_validator

from agents.request_graph import run_request_graph
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
    def validate_decision(self, info: ValidationInfo):
        if not self.answer.strip():
            raise ValueError("답변이 비어 있습니다.")
        # 현재 작업의 업무 종류를 중복 기재한 경우만 생략한다.
        if (self.intent == "operation" and self.task_type is not None
                and self.task_type == (info.context or {}).get("workspace_task_type")):
            self.task_type = None
        if self.intent == "start_task" and self.task_type is None:
            raise ValueError("작업 시작에는 작업 종류가 필요합니다.")
        if self.intent != "start_task" and self.task_type is not None:
            raise ValueError("새 작업 시작 외에는 task_type을 null로 반환해야 합니다.")
        if self.intent == "operation" and self.operation is None:
            raise ValueError("연산 요청에는 연산 설정이 필요합니다.")
        if self.intent != "operation" and self.operation is not None:
            raise ValueError("연산 요청 외에는 operation을 null로 반환해야 합니다.")
        return self


async def route_request(runtime, messages, *, task_context: dict):
    workspace = task_context.get("workspace")
    validation_context = {
        "workspace_task_type": (
            workspace.get("task_type") if workspace else None
        ),
    }

    if runtime.settings.llm.provider == "codex_cli":
        response = await runtime.respond(runtime.request_prompt, {
            "conversation": [
                {"role": message.type, "content": message.content}
                for message in messages
            ],
            "task_context": task_context,
        })
        decision = RequestDecision.model_validate_json(
            response.content.strip(),
            context=validation_context,
        )
        reasoning = get_reasoning_content(response)
        reasons = [reasoning] if reasoning else []

    else:
        result = await run_request_graph(
            runtime,
            messages,
            task_context,
        )
        decision = RequestDecision.model_validate(
            result,
            context=validation_context,
        )
        reasons = []

    if decision.operation:
        if not workspace:
            raise ValueError("먼저 필수 세 열을 지정해 작업을 시작하세요.")

        columns = {
            column["column_id"]
            for column in workspace["columns"]
        }
        if not set(decision.operation.input_column_ids) <= columns:
            raise ValueError("현재 작업 시트에 없는 열을 요청했습니다.")

    if decision.intent == "task_followup" and not (
        workspace or task_context.get("active_job")
    ):
        raise ValueError("후속 질문을 연결할 현재 작업이 없습니다.")

    return decision, reasons
