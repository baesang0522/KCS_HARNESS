from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from services.operations.schemas import ColumnId, StrictModel, Text


TOP_COMBINATIONS = 100


class AdviceRow(StrictModel):
    excel_row: int = Field(ge=1, le=1048576)
    values: list[Text] = Field(min_length=1, max_length=200)
    count: int | None = Field(default=None, ge=1, le=400000)


class AdviceSelection(StrictModel):
    mode: Literal["uppercase_top_combinations"]
    group_column_ids: list[ColumnId] = Field(min_length=3, max_length=3)
    total_rows: int = Field(ge=1, le=400000)
    total_combinations: int = Field(ge=1, le=400000)
    selected_combinations: int = Field(ge=1, le=TOP_COMBINATIONS)
    represented_rows: int = Field(ge=1, le=400000)
    additional_values: Literal["first_row_example_only"]


class AdviceRequest(StrictModel):
    conversation_id: UUID
    request_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    table_id: str = Field(min_length=1, max_length=256)
    row_start: int = Field(ge=0, le=1048575)
    row_count: int = Field(ge=1, le=400000)
    column_ids: list[ColumnId] = Field(min_length=1, max_length=200)
    rows: list[AdviceRow] = Field(min_length=1, max_length=400000)

    selection: AdviceSelection | None = None

    @model_validator(mode="after")
    def validate_data(self):
        if len(set(self.column_ids)) != len(self.column_ids):
            raise ValueError("분석 대상 열이 중복되었습니다.")
        if self.selection is None and len(self.rows) != self.row_count:
            raise ValueError("전체 행 수와 전달된 행 수가 다릅니다.")
        if self.row_start + self.row_count > 1048576:
            raise ValueError("Excel 행 범위를 벗어났습니다.")
        if len(self.rows) * len(self.column_ids) > 2000000:
            raise ValueError("한 번에 최대 200만 셀을 분석합니다.")

        characters = 0
        for offset, row in enumerate(self.rows):
            if self.selection is None and row.excel_row != self.row_start + offset + 1:
                raise ValueError("행이 누락되었거나 순서가 다릅니다.")
            if len(row.values) != len(self.column_ids):
                raise ValueError("분석 열과 데이터의 열 수가 다릅니다.")
            characters += sum(map(len, row.values))

        if characters > 16000000:
            raise ValueError("분석 데이터가 1,600만 글자를 초과했습니다.")

        if self.selection is None:
            if any(row.count is not None for row in self.rows):
                raise ValueError("원문 행에는 집계 건수를 전달할 수 없습니다.")
        else:
            selected = self.selection
            if (selected.total_rows != self.row_count or
                selected.total_combinations > self.row_count or
                selected.selected_combinations != len(self.rows) or
                len(self.rows) != min(TOP_COMBINATIONS, selected.total_combinations)):
                raise ValueError("상위 조합 집계 범위가 올바르지 않습니다.")
            if (len(set(selected.group_column_ids)) != 3 or
                not set(selected.group_column_ids) <= set(self.column_ids)):
                raise ValueError("집계 기준 열이 올바르지 않습니다.")
            if any(row.count is None or not self.row_start < row.excel_row <= self.row_start + self.row_count
                   for row in self.rows):
                raise ValueError("집계 건수 또는 대표 행 번호가 올바르지 않습니다.")
            counts = sum(row.count for row in self.rows)
            missing = selected.total_combinations - len(self.rows)
            if (counts != selected.represented_rows or counts + missing > self.row_count or
                counts + missing * self.rows[-1].count < self.row_count):
                raise ValueError("집계 건수의 합계가 전체 행 수와 맞지 않습니다.")
            if self.rows != sorted(self.rows, key=lambda row: (-row.count, row.excel_row)):
                raise ValueError("집계 결과는 빈도순, 같은 빈도는 첫 행 순서여야 합니다.")
            indexes = [self.column_ids.index(key) for key in selected.group_column_ids]
            keys = [tuple(row.values[i].upper() for i in indexes) for row in self.rows]
            if len(set(keys)) != len(keys) or len({row.excel_row for row in self.rows}) != len(self.rows):
                raise ValueError("집계 결과에 중복 조합이나 대표 행이 있습니다.")
        return self


class Finding(StrictModel):
    excel_rows: list[Annotated[int, Field(ge=1, le=1048576)]] = Field(
        min_length=1,
        max_length=8,
        description="제안을 뒷받침하는 대표 근거 행 번호 1~8개. 해당하는 모든 행을 나열하지 않는다.",
    )
    advice: str = Field(min_length=1, max_length=700)


class Review(StrictModel):
    findings: list[Finding] = Field(default_factory=list, max_length=8)
