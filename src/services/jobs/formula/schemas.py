import re
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


CellText = Annotated[str, Field(max_length=1000)]
CELL = re.compile(r"^\$?([A-Z]{1,3})\$?([1-9]\d*)$")
RANGE = re.compile(
    r"^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$"
)
BLOCKED_FORMULA = re.compile(
    r"(?:https?://|\b(?:WEBSERVICE|HYPERLINK|RTD|CALL|EXEC|REGISTER\.ID)\s*\()",
    re.IGNORECASE,
)
EMPTY_SINGLE_TEXT = re.compile(r"(?<![A-Za-z0-9_])''(?=$|[,;)])")
SINGLE_QUOTED_TEXT = re.compile(r"'([^']+)'(?=\s*[,;)])")
LOOKUP_FUNCTION = re.compile(
    r"\b(?:XLOOKUP|VLOOKUP|HLOOKUP|LOOKUP|INDEX|MATCH)\s*\(",
    re.IGNORECASE,
)
CELL_RANGE_REFERENCE = re.compile(
    r"(?<![A-Z0-9_])\$?([A-Z]{1,3})\$?([1-9]\d*):"
    r"\$?([A-Z]{1,3})\$?([1-9]\d*)",
    re.IGNORECASE,
)
EXCEL_TEXT = re.compile(r'("(?:[^"]|"")*")')


def _absolute_lookup_ranges(formula: str) -> str:
    if not LOOKUP_FUNCTION.search(formula):
        return formula
    parts = EXCEL_TEXT.split(formula)
    for index in range(0, len(parts), 2):
        parts[index] = CELL_RANGE_REFERENCE.sub(
            lambda match: (
                f"${match.group(1).upper()}${match.group(2)}:"
                f"${match.group(3).upper()}${match.group(4)}"
            ),
            parts[index],
        )
    return "".join(parts)


def _cell_parts(address: str) -> tuple[int, int]:
    match = CELL.fullmatch(address.replace("$", ""))
    if not match:
        raise ValueError("셀 주소가 올바르지 않습니다.")
    column = 0
    for character in match.group(1):
        column = column * 26 + ord(character) - 64
    row = int(match.group(2))
    if column > 16384 or row > 1048576:
        raise ValueError("셀 주소가 Excel 범위를 벗어납니다.")
    return row, column


def range_bounds(address: str) -> tuple[int, int, int, int]:
    start, _, end = address.replace("$", "").partition(":")
    start_row, start_column = _cell_parts(start)
    end_row, end_column = _cell_parts(end or start)
    if end_row < start_row or end_column < start_column:
        raise ValueError("대상 범위의 시작과 끝을 확인하세요.")
    return start_row, start_column, end_row, end_column


class FormulaSampleRow(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    cells: tuple[CellText, ...] = Field(min_length=1, max_length=20)


class FormulaSheetContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0, lt=1048576)
    column_start: int = Field(ge=0, lt=16384)
    row_count: int = Field(ge=1, le=1048576)
    column_count: int = Field(ge=1, le=16384)
    samples: tuple[FormulaSampleRow, ...] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_samples(self):
        sampled_columns = min(self.column_count, 20)
        if any(len(row.cells) != sampled_columns for row in self.samples):
            raise ValueError("시트 표본의 열 수가 사용 영역과 다릅니다.")
        return self


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_type: Literal["formula"]
    conversation_id: UUID
    job_id: UUID
    instruction: str = Field(min_length=1, max_length=8000)
    worksheet_id: str = Field(min_length=1, max_length=256)
    sheet_name: str = Field(min_length=1, max_length=256)
    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0, lt=1048576)
    column_start: int = Field(ge=0, lt=16384)
    row_count: int = Field(ge=1, le=400000)
    column_count: int = Field(ge=1, le=20)
    samples: tuple[FormulaSampleRow, ...] = Field(min_length=1, max_length=20)
    sheet_context: FormulaSheetContext | None = None

    @model_validator(mode="after")
    def validate_selection(self):
        if self.row_start + self.row_count > 1048576:
            raise ValueError("선택 범위가 Excel 행 경계를 벗어납니다.")
        if self.column_start + self.column_count > 16384:
            raise ValueError("선택 범위가 Excel 열 경계를 벗어납니다.")
        if any(len(row.cells) != self.column_count for row in self.samples):
            raise ValueError("표본의 열 수가 선택 범위와 다릅니다.")
        return self


class FormulaAction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    target_range: str = Field(min_length=2, max_length=64)
    anchor_cell: str = Field(min_length=2, max_length=16)
    formula: str = Field(min_length=2, max_length=8192)
    output_label: str = Field(default="결과", min_length=1, max_length=100)
    mode: Literal["single", "fill_down"]
    overwrite: Literal["reject_nonblank"] = "reject_nonblank"

    @field_validator("target_range")
    @classmethod
    def validate_target_range(cls, value: str) -> str:
        value = value.strip().upper()
        if not RANGE.fullmatch(value):
            raise ValueError("대상 범위는 현재 시트의 A1 주소 형식이어야 합니다.")
        return value

    @field_validator("anchor_cell")
    @classmethod
    def validate_anchor(cls, value: str) -> str:
        value = value.strip().upper()
        if not CELL.fullmatch(value):
            raise ValueError("기준 셀은 A1 주소 형식이어야 합니다.")
        return value

    @field_validator("formula")
    @classmethod
    def validate_formula(cls, value: str) -> str:
        value = value.strip()
        if not value.startswith("="):
            raise ValueError("수식은 =으로 시작해야 합니다.")
        if any(character in value for character in "\r\n\x00"):
            raise ValueError("수식에는 줄바꿈이나 제어 문자를 사용할 수 없습니다.")
        if (
            "[" in value or "]" in value or "|" in value
            or BLOCKED_FORMULA.search(value)
        ):
            raise ValueError("외부 통합문서·웹·실시간 데이터 참조는 지원하지 않습니다.")
        # Excel text literals use double quotes. Repair the common LLM typo
        # for an empty literal while leaving escaped apostrophes in sheet names alone.
        value = EMPTY_SINGLE_TEXT.sub('""', value)
        value = SINGLE_QUOTED_TEXT.sub(r'"\1"', value)
        return _absolute_lookup_ranges(value)

    @model_validator(mode="after")
    def validate_shape(self):
        start_row, start_column, end_row, end_column = range_bounds(
            self.target_range
        )
        if _cell_parts(self.anchor_cell) != (start_row, start_column):
            raise ValueError("기준 셀은 대상 범위의 왼쪽 위 셀이어야 합니다.")
        cells = (end_row - start_row + 1) * (end_column - start_column + 1)
        if cells > 10000:
            raise ValueError("첫 수식 작업은 최대 10,000셀까지 지원합니다.")
        if self.mode == "single" and cells != 1:
            raise ValueError("단일 수식의 대상은 한 셀이어야 합니다.")
        if self.mode == "fill_down" and end_column != start_column:
            raise ValueError("세로 채우기 대상은 한 열이어야 합니다.")
        return self


class FormulaPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1]
    summary: str = Field(min_length=1, max_length=500)
    actions: tuple[FormulaAction, ...] = Field(default=(), max_length=3)
    clarification: str | None = Field(default=None, min_length=1, max_length=500)
    warnings: tuple[str, ...] = Field(default=(), max_length=10)

    @model_validator(mode="after")
    def validate_outcome(self):
        if bool(self.actions) == bool(self.clarification):
            raise ValueError("수식 작업 또는 확인 질문 중 하나만 반환해야 합니다.")
        if self.actions:
            bounds = [range_bounds(action.target_range) for action in self.actions]
            if len(set(action.target_range for action in self.actions)) != len(self.actions):
                raise ValueError("결과 범위가 서로 겹칩니다.")
            first_rows = (bounds[0][0], bounds[0][2])
            if any((item[0], item[2]) != first_rows for item in bounds[1:]):
                raise ValueError("복수 결과 범위의 행은 서로 같아야 합니다.")
        return self


class FormulaHistoryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    instruction: str
    sheet_name: str
    source_address: str
    status: str
    plan: FormulaPlan


class FormulaConversationMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class FormulaPlanningContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    previous_instruction: str | None = None
    previous_sheet_name: str | None = None
    previous_address: str | None = None
    previous_status: str | None = None
    previous_plan: FormulaPlan | None = None
    previous_plans: tuple[FormulaHistoryEntry, ...] = Field(default=(), max_length=5)
    recent_conversation: tuple[FormulaConversationMessage, ...] = Field(
        default=(), max_length=10,
    )


class FormulaPreview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    preview_id: UUID = Field(default_factory=uuid4)
    plan: FormulaPlan


class FormulaApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    target_range: str | None = Field(default=None, min_length=2, max_length=64)
    target_ranges: tuple[str, ...] = Field(default=(), max_length=3)

    @field_validator("target_range")
    @classmethod
    def validate_target_range(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return FormulaAction.validate_target_range(value)

    @field_validator("target_ranges")
    @classmethod
    def validate_target_ranges(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(FormulaAction.validate_target_range(value) for value in values)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.target_range and self.target_ranges:
            raise ValueError("결과 범위 형식은 하나만 사용하세요.")
        ranges = self.target_ranges or ((self.target_range,) if self.target_range else ())
        if not ranges:
            raise ValueError("결과 범위가 필요합니다.")
        for address in ranges:
            _, start_column, _, end_column = range_bounds(address)
            if start_column != end_column:
                raise ValueError("결과 범위는 한 열이어야 합니다.")
        return self

    def ranges(self) -> tuple[str, ...]:
        return self.target_ranges or (self.target_range,)  # type: ignore[return-value]


class Job(BaseModel):
    task_type: Literal["formula"] = "formula"
    status: Literal[
        "CREATED", "PLANNING", "PREVIEW_READY", "NEEDS_INPUT", "FAILED", "APPLIED"
    ] = "CREATED"
    source: CreateJobRequest
    preview: FormulaPreview | None = None
    planning_context: FormulaPlanningContext | None = None
    approved_preview_id: UUID | None = None
    error: str = ""
