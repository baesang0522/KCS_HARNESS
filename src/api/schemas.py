from uuid import UUID
from typing import Annotated, Literal
from services.similarity import SimilaritySelection
from pydantic import BaseModel, Field, field_validator
from services.operations.schemas import ColumnId, Operation, WorkspaceContext


class ChatRequest(BaseModel):
    conversation_id: UUID
    request_id: UUID
    message: str = Field(min_length=1, max_length=8000)
    workspace: WorkspaceContext | None = None
    advice_requested: bool = False

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
    workspace_id: UUID | None = None
    column_ids: list[ColumnId] | None = Field(default=None, min_length=1, max_length=20)


class ConfigureOperationAction(BaseModel):
    type: Literal["configure_operation"]
    operation: Operation


class ConfigureSimilarityAction(BaseModel):
    type: Literal["configure_similarity"]
    similarity: SimilaritySelection


class AnalyzeDataAction(BaseModel):
    type: Literal["analyze_data"]
    column_ids: list[ColumnId] = Field(min_length=1, max_length=200)


class OpenCleaningHelpAction(BaseModel):
    type: Literal["open_cleaning_help"]
    column_ids: list[ColumnId] | None = Field(default=None, min_length=1, max_length=1)


UIAction = Annotated[
    ConfirmSelectionAction
    | ConfigureOperationAction
    | ConfigureSimilarityAction
    | AnalyzeDataAction
    | OpenCleaningHelpAction,
    Field(discriminator="type"),
]


class ChatResponse(BaseModel):
    conversation_id: str
    request_id: str
    answer: str
    reasoning: list[str]
    ui_action: UIAction | None = None
