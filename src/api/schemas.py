from uuid import UUID
from typing import Annotated, Literal
from pydantic import BaseModel, Field, field_validator
from services.operations.schemas import Operation, WorkspaceContext


class ChatRequest(BaseModel):
    conversation_id: UUID
    request_id: UUID
    message: str = Field(min_length=1, max_length=8000)
    workspace: WorkspaceContext | None = None

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        value = value.strip()

        if not value:
            raise ValueError("메세지는 비어있을 수 없습니다.")

        return value


class ConfirmSelectionAction(BaseModel):
    type: Literal["confirm_selection"]
    task_type: Literal[
        "model_normalization",
        "counterparty_cleanup",
        "formula",
    ]


class ConfigureOperationAction(BaseModel):
    type: Literal["configure_operation"]
    operation: Operation


UIAction = Annotated[
    ConfirmSelectionAction | ConfigureOperationAction,
    Field(discriminator="type"),
]


class ChatResponse(BaseModel):
    conversation_id: str
    request_id: str
    answer: str
    reasoning: list[str]
    ui_action: UIAction | None = None
