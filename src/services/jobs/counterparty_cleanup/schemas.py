from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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


class CounterpartyPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    similarity_threshold: float = Field(default=0.9, ge=0.8, le=1.0)
    ignored_terms: tuple[str, ...] = Field(default=(), max_length=30)

    @field_validator("ignored_terms")
    @classmethod
    def normalize_terms(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        cleaned = tuple(dict.fromkeys(value.strip().upper() for value in values if value.strip()))
        if any(len(value) > 50 for value in cleaned):
            raise ValueError("무시할 단어는 각각 50자 이하여야 합니다.")
        return cleaned


class PolicySuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    instruction: str = Field(default="", max_length=1000)


class PolicySuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    policy: CounterpartyPolicy
    reason: str = Field(min_length=1, max_length=500)


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
        labels = {
            "party_code": "해외거래처부호",
            "country_code": "국가코드",
            "company_name": "상호명",
        }
        for role, index in self.mapping.model_dump().items():
            if not any(row.cells[index].strip() for row in self.rows):
                raise ValueError(f"선택한 {labels[role]} 열이 모두 비어 있습니다.")
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


class CandidateDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    group_id: str = Field(min_length=1, max_length=100)
    decision: Literal["APPROVE", "EXCLUDE"]
    representative_party_code: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def representative_required(self):
        if self.decision == "APPROVE" and not (
            self.representative_party_code or ""
        ).strip():
            raise ValueError("승인 후보의 대표 해외거래처부호를 선택하세요.")
        if self.decision == "EXCLUDE" and self.representative_party_code is not None:
            raise ValueError("제외 후보에는 대표 해외거래처부호를 지정할 수 없습니다.")
        return self


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    decisions: tuple[CandidateDecision, ...]


class PreviewRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    group_id: str
    excel_row: int = Field(ge=1)
    country_code: str
    company_name: str
    original_party_code: str
    representative_party_code: str
    changed: bool


class CounterpartyPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    preview_id: UUID = Field(default_factory=uuid4)
    decisions: tuple[CandidateDecision, ...]
    approved_group_count: int
    excluded_group_count: int
    row_count: int
    changed_count: int
    rows: tuple[PreviewRow, ...]
    policy: CounterpartyPolicy


class Job(BaseModel):
    task_type: Literal["counterparty_cleanup"] = "counterparty_cleanup"
    status: Literal[
        "CANDIDATES_READY", "REVIEWING", "REVIEW_READY", "REVIEW_FAILED"
    ] = "CANDIDATES_READY"
    source: CreateJobRequest
    policy: CounterpartyPolicy = Field(default_factory=CounterpartyPolicy)
    policy_suggestion: PolicySuggestion | None = None
    same_country_only: Literal[True] = True
    review_results: list[ReviewResult] = Field(default_factory=list)
    preview: CounterpartyPreview | None = None
    approved_preview_id: UUID | None = None
    error: str = ""
