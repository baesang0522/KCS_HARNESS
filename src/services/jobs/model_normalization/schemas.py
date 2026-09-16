from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


Operation = Literal["trim", "collapse_whitespace"]


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

    rule_set: RuleSet
    sample_count: int
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


class SampleRow(BaseModel):
    cells: list[CellText] = Field(min_length=3, max_length=3)


class CreateJobRequest(BaseModel):
    conversation_id: UUID
    job_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    sheet_name: str = Field(min_length=1, max_length=256)
    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0)
    column_start: int = Field(ge=0)
    row_count: int = Field(ge=0, le=400001)
    headers: list[CellText] = Field(min_length=3, max_length=3)
    mapping: ColumnMapping
    samples: list[SampleRow] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def check_samples(self):
        if len(self.samples) > self.row_count - 1:
            raise ValueError("표본 수가 선택 가능한 데이터 행 수보다 많습니다.")

        if not any(cell.strip() for row in self.samples for cell in row.cells):
            raise ValueError("표본 데이터가 모두 비어 있습니다.")

        return self


class Job(BaseModel):
    source: CreateJobRequest
    status: Literal["CREATED", "ANALYZING", "REVIEW_READY", "FAILED"] = "CREATED"
    analysis: str = ""
    error: str = ""
