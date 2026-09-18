from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


Operation = Literal[
    "trim",
    "collapse_whitespace",
    "normalize_fullwidth_ascii",
]


class NormalizationRule(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Operation


class RuleSet(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    rules: tuple[NormalizationRule, ...] = Field(
        min_length=1,
        max_length=10,
    )


class NormalizationRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    excel_row: int = Field(ge=1)
    trade_name: str
    declared_name: str
    model_spec: str


class PreviewRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    excel_row: int
    trade_name: str
    declared_name: str
    original_model_spec: str
    normalized_model_spec: str
    changed: bool
    applied_operations: tuple[Operation, ...]


class NormalizationPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    preview_id: UUID = Field(default_factory=uuid4)
    rule_set: RuleSet
    row_count: int
    changed_count: int
    rows: tuple[PreviewRow, ...]


CellText = Annotated[str, Field(max_length=1000)]
ColumnIndex = Annotated[int, Field(ge=0, le=2)]

class ColumnMapping(BaseModel):
    trade_name: ColumnIndex
    declared_name: ColumnIndex
    model_spec: ColumnIndex

    @model_validator(mode="after")
    def check_distinct(self):
        indexes = {
            self.trade_name,
            self.declared_name,
            self.model_spec,
        }
        if len(indexes) != 3:
            raise ValueError("세 역할에는 서로 다른 열을 지정하세요. ")
        return self


class InputRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cells: tuple[CellText, ...] = Field(min_length=3, max_length=3)


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    conversation_id: UUID
    job_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    sheet_name: str = Field(min_length=1, max_length=256)
    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0)
    column_start: int = Field(ge=0)
    row_count: int = Field(ge=2, le=400001)
    headers: list[CellText] = Field(min_length=3, max_length=3)
    mapping: ColumnMapping
    rows: list[InputRow] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def check_rows(self):
        if len(self.rows) != self.row_count - 1:
            raise ValueError(
                "선택 범위의 데이터 행 수와 전송된 행 수가 다릅니다."
            )

        if self.row_start + self.row_count > 1048576:
            raise ValueError("선택 범위가 Excel 행 경계를 벗어납니다.")

        if self.column_start + 3 > 16384:
            raise ValueError("선택 범위가 Excel 열 경계를 벗어납니다.")

        if not any(
            cell.strip()
            for row in self.rows
            for cell in row.cells
        ):
            raise ValueError("선택한 데이터가 모두 비어 있습니다.")

        return self


class Job(BaseModel):
    source: CreateJobRequest
    preview: NormalizationPreview | None = None
    approved_preview_id: UUID | None = None

    status: Literal[
        "CREATED",
        "ANALYZING",
        "REVIEW_READY",
        "PREVIEWING",
        "FAILED",
    ] = "CREATED"

    analyzed_row_count: int = 0
    processed_row_count: int = 0
    analysis_batch_count: int = 0
    completed_analysis_batches: int = 0
    analysis_phase: Literal[
        "NOT_STARTED", "INSPECTING", "COMBINING", "DONE"
    ] = "NOT_STARTED"

    analysis: str = ""
    error: str = ""
