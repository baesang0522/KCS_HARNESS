from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


CellText = Annotated[str, Field(max_length=1000)]
ColumnIndex = Annotated[int, Field(ge=0, le=2)]


class ColumnMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    party_code: ColumnIndex
    country_code: ColumnIndex
    company_name: ColumnIndex

    @model_validator(mode="after")
    def distinct(self):
        if len(set(self.model_dump().values())) != 3:
            raise ValueError("부호·국가·상호에는 서로 다른 열을 지정하세요.")
        return self


class InputRow(BaseModel):
    cells: list[CellText] = Field(min_length=3, max_length=3)


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: UUID
    job_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    sheet_name: str = Field(min_length=1, max_length=256)
    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0)
    column_start: int = Field(ge=0)
    row_count: int = Field(ge=2)
    headers: list[CellText] = Field(min_length=3, max_length=3)
    mapping: ColumnMapping
    rows: list[InputRow] = Field(min_length=1)

    @model_validator(mode="after")
    def complete_input(self):
        if len(self.rows) != self.row_count - 1:
            raise ValueError("선택 범위의 데이터 행 수와 전송된 행 수가 다릅니다.")
        if any(not header.strip() for header in self.headers):
            raise ValueError("세 열의 머리글을 포함해 선택하세요.")
        if not any(row.cells[self.mapping.company_name].strip() for row in self.rows):
            raise ValueError("선택한 상호명 열이 모두 비어 있습니다.")
        return self


class ModelReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_id: str = Field(min_length=1, max_length=100)
    decision: Literal[
        "SAME_HIGH_CONFIDENCE", "NEEDS_REVIEW", "LIKELY_DIFFERENT"
    ]
    reason: str = Field(min_length=1, max_length=500)


class ModelReviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reviews: list[ModelReview]


class ReviewResult(ModelReview):
    country_code: str
    rows: list[dict]
    existing_party_codes: list[str]
    similarity: float | None = None


class Job(BaseModel):
    task_type: Literal["counterparty_cleanup"] = "counterparty_cleanup"
    status: Literal[
        "CANDIDATES_READY", "REVIEWING", "REVIEW_READY", "REVIEW_FAILED"
    ] = "CANDIDATES_READY"
    source: CreateJobRequest
    same_country_only: Literal[True] = True
    review_results: list[ReviewResult] = Field(default_factory=list)
    error: str = ""
