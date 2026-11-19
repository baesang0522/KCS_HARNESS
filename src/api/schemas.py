from uuid import UUID
from typing import Annotated, Literal
from services.similarity import SimilaritySelection
from services.group_review import GroupReviewRequest
from pydantic import BaseModel, Field, field_validator
from services.operations.schemas import ColumnId, Operation, RowScope, ScopeRequest, WorkspaceContext


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
    instruction: str | None = None
    type: Literal["confirm_selection"]
    task_type: Literal[
        "investigation", "model_normalization",
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


class OpenGroupReviewAction(BaseModel):
    type: Literal["open_group_review"]
    request: GroupReviewRequest | None = None
    column_ids: list[ColumnId] | None = Field(default=None, min_length=1, max_length=1)


class ChangeScopeAction(BaseModel):
    type: Literal["change_scope"]
    workspace_id: UUID
    request: ScopeRequest
    expected_filter: RowScope | None = None


class OpenInvestigationAction(BaseModel):
    type: Literal["open_investigation"]


class AgentAction(BaseModel):
    type: Literal["agent_run"]
    run_id: UUID


UIAction = Annotated[
    ConfirmSelectionAction
    | ConfigureOperationAction
    | ConfigureSimilarityAction
    | AnalyzeDataAction
    | OpenCleaningHelpAction
    | OpenGroupReviewAction
    | OpenInvestigationAction
    | ChangeScopeAction
    | AgentAction,
    Field(discriminator="type"),
]


class ChatResponse(BaseModel):
    conversation_id: str
    request_id: str
    answer: str
    reasoning: list[str]
    ui_action: UIAction | None = None
