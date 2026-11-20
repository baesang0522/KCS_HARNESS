"""목표 실행의 요청·Excel 응답과 메모리 상태 자료형."""
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID
from pydantic import Field, model_validator
from services.operations.schemas import ColumnId, RowFilter, StrictModel, WorkspaceContext
from services.similarity import SimilaritySettings


class ReadAction(StrictModel):
    column_ids: list[ColumnId] = Field(min_length=1, max_length=200)
    condition: RowFilter | None = None
    similarity: SimilaritySettings | None = None

    @model_validator(mode="after")
    def columns_match(self):
        if len(set(self.column_ids)) != len(self.column_ids):
            raise ValueError("읽을 열 ID가 중복되었습니다.")
        if self.similarity and self.column_ids != self.similarity.input_column_ids:
            raise ValueError("비교 열과 읽을 열이 다릅니다.")
        return self


class ReadRow(StrictModel):
    identity: int = Field(ge=1, le=1048576)
    excel_row: int = Field(ge=1, le=1048576)
    values: list[str]


class Receipt(StrictModel):
    step_id: UUID
    status: Literal["SUCCEEDED", "FAILED", "UNKNOWN"]
    rows: list[ReadRow] | None = None
    message: str = Field(default="", max_length=8000)


class Advance(StrictModel):
    request_id: UUID
    workspace: WorkspaceContext
    receipt: Receipt | None = None


class PauseRun(StrictModel):
    message: str = Field(default="", max_length=8000)


class BindJob(StrictModel):
    step_id: UUID
    job_id: UUID
    kind: Literal["operation", "formula"]


@dataclass
class AgentRun:
    id: str
    goal: str
    workspace: dict
    status: str = "READY"
    answer: str = "현재 상태를 확인하고 있습니다."
    step: dict | None = None
    observation: dict | None = None
    history: list = field(default_factory=list)
    read_results: list = field(default_factory=list)
    requests: dict = field(default_factory=dict)
    seen: set = field(default_factory=set)
    request_id: str | None = None
    message: str = ""
    user_request: str = ""
    code_grouping_request: str | None = None
    steps: int = 0
    deadline: float | None = None
