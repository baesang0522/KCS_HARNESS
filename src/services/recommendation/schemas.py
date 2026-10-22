from typing import Annotated
from uuid import UUID

from pydantic import Field, model_validator

from services.operations.schemas import ColumnId, StrictModel, Text


class AdviceRow(StrictModel):
    excel_row: int = Field(ge=1, le=1048576)
    values: list[Text] = Field(min_length=1, max_length=200)


class AdviceRequest(StrictModel):
    conversation_id: UUID
    request_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    table_id: str = Field(min_length=1, max_length=256)
    row_start: int = Field(ge=0, le=1048575)
    row_count: int = Field(ge=1, le=400000)
    column_ids: list[ColumnId] = Field(min_length=1, max_length=200)
    rows: list[AdviceRow] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def validate_data(self):
        if len(set(self.column_ids)) != len(self.column_ids):
            raise ValueError("분석 대상 열이 중복되었습니다.")
        if len(self.rows) != self.row_count:
            raise ValueError("전체 행 수와 전달된 행 수가 다릅니다.")
        if self.row_start + self.row_count > 1048576:
            raise ValueError("Excel 행 범위를 벗어났습니다.")
        if self.row_count * len(self.column_ids) > 2000000:
            raise ValueError("한 번에 최대 200만 셀을 분석합니다.")

        characters = 0
        for offset, row in enumerate(self.rows):
            if row.excel_row != self.row_start + offset + 1:
                raise ValueError("행이 누락되었거나 순서가 다릅니다.")
            if len(row.values) != len(self.column_ids):
                raise ValueError("분석 열과 데이터의 열 수가 다릅니다.")
            characters += sum(map(len, row.values))

        if characters > 16000000:
            raise ValueError("분석 데이터가 1,600만 글자를 초과했습니다.")

        return self


class ComparisonPlan(StrictModel):
    column_ids: list[ColumnId] = Field(default_factory=list, max_length=3)


class Finding(StrictModel):
    excel_rows: list[Annotated[int, Field(ge=1, le=1048576)]] = Field(
        min_length=1,
        max_length=8,
    )
    advice: str = Field(min_length=1, max_length=700)


class Review(StrictModel):
    findings: list[Finding] = Field(default_factory=list, max_length=8)


class CheckedFinding(StrictModel):
    finding: Finding | None = None
