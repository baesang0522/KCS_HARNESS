"""화면과 자연어 요청이 공유하는 연산 계약."""
import json
from uuid import UUID
from decimal import Decimal, InvalidOperation
import re
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from services.operations.dimensions import DimensionRules

Text = Annotated[str, Field(max_length=32767)]
ColumnId = Annotated[str, Field(min_length=1, max_length=256)]
TaskType = Literal["investigation", "model_normalization", "counterparty_cleanup"]
FIND_REQUIRED = "찾을 문자열을 입력하세요."


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def mapping_key(value: str) -> str:
    return " ".join(value.split()).upper()


class Mapping(StrictModel):
    source: Text
    target: Text


class ValueRequest(StrictModel):
    values: list[Text] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def validate_size(self):
        if sum(map(len, self.values)) > 16000000:
            raise ValueError("문자열이 너무 많습니다. 대상 행을 줄여 주세요.")
        return self


def extraction_column_id(workspace: dict | None) -> str:
    if not workspace:
        raise ValueError("모델규격 추출은 모델규격 정제 작업에서만 사용할 수 있습니다.")
    columns = [column for column in workspace["columns"] if column.get("role") == "model_spec"]
    if len(columns) != 1:
        raise ValueError("작업 준비에서 모델규격명 열을 하나 지정하세요.")
    return str(columns[0]["column_id"])


class Rule(StrictModel):
    operation: Literal["trim", "collapse_whitespace", "normalize_fullwidth_ascii",
                       "uppercase", "lowercase", "remove_words", "remove_hangul", "remove_brackets"]
    words: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_words(self):
        if self.operation == "remove_words":
            if not self.words or any(not word.strip() for word in self.words):
                raise ValueError("제거할 단어를 입력하세요.")
        elif self.words:
            raise ValueError("단어 목록은 단어 제거에서만 사용합니다.")
        return self


class RowFilter(StrictModel):
    column_id: ColumnId
    operator: Literal["equals", "not_equals", "contains", "blank", "not_blank", "gt", "gte", "lt", "lte"]
    value: Text = ""


    @model_validator(mode="after")
    def validate_number(self):
        if self.operator in {"gt", "gte", "lt", "lte"} and self.number(self.value) is None:
            raise ValueError("숫자 비교 기준은 단위를 정리한 유한한 숫자로 지정하세요.")
        return self

    @staticmethod
    def number(value):
        text = str(value).strip()
        if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
            return None
        try:
            result = Decimal(text)
            return result if result.is_finite() and math.isfinite(float(result)) else None
        except (InvalidOperation, OverflowError, ValueError):
            return None

    def matches(self, value):
        if self.operator in {"gt", "gte", "lt", "lte"}:
            actual, wanted = self.number(value), self.number(self.value)
            if actual is None:
                return None
            return {"gt": actual > wanted, "gte": actual >= wanted,
                    "lt": actual < wanted, "lte": actual <= wanted}[self.operator]
        return {"equals": value == self.value, "not_equals": value != self.value,
                "contains": self.value in value, "blank": not value.strip(),
                "not_blank": bool(value.strip())}[self.operator]

    @property
    def column_ids(self) -> list[str]:
        return [self.column_id]


class FilterGroup(StrictModel):
    operator: Literal["all", "any"]
    conditions: list["RowFilter | FilterGroup"] = Field(min_length=1)

    @property
    def column_ids(self) -> list[str]:
        return list(dict.fromkeys(key for item in self.conditions for key in item.column_ids))


Predicate = RowFilter | FilterGroup


class ScopeStep(StrictModel):
    mode: Literal["include", "exclude", "intersect"]
    condition: Predicate


class CombinedRowFilter(StrictModel):
    base: "RowFilter | FilterGroup | RowIdentities | CombinedRowFilter | None" = None
    steps: list[ScopeStep] = Field(min_length=1)
    base_ids: list[Annotated[int, Field(gt=0)]] | None = None

    @model_validator(mode="after")
    def validate_ids(self):
        if self.base_ids is not None and len(self.base_ids) != len(set(self.base_ids)):
            raise ValueError("작업 범위의 행 식별값이 중복되었습니다.")
        return self

    @property
    def column_ids(self) -> list[str]:
        return list(dict.fromkeys((self.base.column_ids if self.base else []) +
                                  [key for step in self.steps for key in step.condition.column_ids]))


class RowIdentities(StrictModel):
    row_ids: list[Annotated[int, Field(gt=0)]]

    @model_validator(mode="after")
    def unique_ids(self):
        if len(self.row_ids) != len(set(self.row_ids)):
            raise ValueError("선별 행 식별값이 중복되었습니다.")
        return self

    @property
    def column_ids(self) -> list[str]:
        return []


RowScope = RowFilter | FilterGroup | RowIdentities | CombinedRowFilter


class ScopeRequest(StrictModel):
    mode: Literal["replace", "include", "exclude", "intersect", "clear", "revisit"]
    condition: Predicate | None = None
    condition_ids: list[str] = Field(default_factory=list)
    condition_versions: dict[str, str] = Field(default_factory=dict)
    note: str = Field(default="", max_length=2000)
    stage_id: str | None = None
    revisit: Literal["pending", "input"] = "pending"

    @model_validator(mode="after")
    def validate_condition(self):
        if (self.mode in {"clear", "revisit"}) != (self.condition is None):
            raise ValueError("전체 범위 해제 외에는 조건을 지정하세요.")
        if (self.mode == "revisit") != (self.stage_id is not None):
            raise ValueError("재검토할 선별 단계 ID를 지정하세요.")
        if self.mode in {"clear", "revisit"} and (self.condition_ids or self.condition_versions):
            raise ValueError("범위 복귀는 PDF 조건을 새로 적용하지 않습니다.")
        pending = [self.condition] if self.condition else []
        while pending:
            condition = pending.pop()
            if isinstance(condition, FilterGroup):
                pending.extend(condition.conditions)
            elif condition.operator not in {"blank", "not_blank"} and not condition.value.strip():
                raise ValueError("비교할 값을 입력하세요. 빈 셀은 빈칸 조건을 사용하세요.")
        return self


class OperationOutput(StrictModel):
    score_column_id: ColumnId | None = None
    mode: Literal["new", "existing"] = "new"
    column_id: ColumnId | None = Field(default=None, description="mode=existing이면 사용자가 요청한 저장 대상 열의 실제 workspace.columns.column_id를 반드시 지정한다. 열 이름은 ID가 아니다.")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    anchor: ColumnId | None = None
    side: Literal["before", "after"] = "after"

    @model_validator(mode="before")
    @classmethod
    def parse_output(cls, value):
        # 일부 모델은 중첩된 저장 위치 객체를 JSON 문자열로 한 번 더 직렬화한다.
        if isinstance(value, str):
            if value.strip() == "new":
                return {"mode": "new"}
            try:
                value = json.loads(value)
            except ValueError:
                raise ValueError('output은 저장 위치 객체여야 합니다. 새 열은 {"mode":"new"}, 기존 열은 {"mode":"existing","column_id":"실제 열 ID"}로 전달하세요.') from None
        if not isinstance(value, (dict, cls)):
            raise ValueError('output은 저장 위치 객체여야 합니다. 문자열·목록 대신 mode와 필요한 열 정보를 객체로 전달하세요.')
        return value

    @model_validator(mode="after")
    def validate_output(self):
        if self.score_column_id and (self.mode != "existing" or self.score_column_id == self.column_id):
            raise ValueError("유사도 점수는 그룹명과 다른 기존 열이어야 합니다.")
        if self.mode == "existing" and not self.column_id:
            raise ValueError('반영할 기존 열 ID를 지정하세요. output={"mode":"existing","column_id":"workspace.columns의 실제 ID"}로 전달하세요. 새 열에 저장하려면 {"mode":"new"}입니다.')
        if self.mode == "new" and self.column_id is not None:
            raise ValueError("새 열에는 기존 대상 열 ID를 지정하지 마세요.")
        if self.name is not None and not self.name.strip():
            raise ValueError("결과 열 이름은 비어 있을 수 없습니다.")
        return self


class Operation(StrictModel):
    dimensions: DimensionRules | None = None
    similarity_threshold: float | None = Field(default=None, ge=0, le=100)
    similarity_method: Literal["auto", "levenshtein", "sequence"] | None = None
    output: OperationOutput | None = None
    kind: Literal["preprocess", "split", "group", "replace", "map", "extract", "set", "match_suppliers", "dimensions"]
    column_ids: list[ColumnId] = Field(min_length=1, max_length=20)
    rules: list[Rule] = Field(default_factory=list, max_length=10)
    delimiter: str | None = Field(default=None, min_length=1, max_length=100)
    find: Text | None = None
    replacement: Text = ""
    mappings: list[Mapping] = Field(default_factory=list, max_length=1000)
    value_column_id: ColumnId | None = None
    source_row: int | None = Field(default=None, ge=1, le=1048576)
    representative: Text | None = None
    part: Literal["all", "last"] = "all"
    group_mode: Literal["manual", "first_non_empty"] = "manual"
    extraction_mode: Literal["pdf", "alphanumeric", "labelled"] | None = None
    assigned_value: Text | None = None
    condition: RowFilter | None = None
    condition_scope: Literal["current", "all"] = "current"
    destination_column_id: ColumnId | None = None

    @property
    def input_column_ids(self) -> list[str]:
        ids = self.column_ids + ([self.value_column_id] if self.kind == "group" else [])
        if self.kind == "dimensions" and self.condition and self.condition.column_id not in ids:
            ids = ids + [self.condition.column_id]
        return ids

    @model_validator(mode="after")
    def validate_operation(self):
        if (self.kind == "dimensions") != (self.dimensions is not None):
            raise ValueError("규격 파싱에는 품목과 파싱 규칙이 필요합니다.")
        if self.kind == "dimensions":
            if self.destination_column_id is not None:
                raise ValueError("치수 결과 위치는 output으로 지정하세요.")
            if self.output and self.output.mode == "existing":
                if len(self.dimensions.selected_fields) != 1:
                    raise ValueError("기존 열에는 추출할 치수 항목 하나를 지정하세요.")
                if self.output.column_id in self.input_column_ids:
                    raise ValueError("치수 결과 열은 원본·조건 열과 달라야 합니다.")
        if self.kind == "match_suppliers":
            if len(self.column_ids) != 1:
                raise ValueError("비교할 해외거래처 열 하나를 지정하세요.")
            if self.destination_column_id is not None:
                raise ValueError("거래처 결과 위치는 output으로 지정하세요.")
            if self.output and self.output.mode == "existing":
                outputs = [self.output.column_id, self.output.score_column_id]
                if set(filter(None, outputs)) & set(self.column_ids):
                    raise ValueError("거래처 원본과 그룹·점수 결과 열은 서로 달라야 합니다.")
                expected = RowFilter(column_id=self.output.column_id, operator="blank", value="")
                if self.condition is not None and self.condition != expected:
                    raise ValueError("거래처 재비교는 기존 그룹명이 빈 행에만 적용합니다.")
                self.condition = expected
            elif self.condition:
                raise ValueError("미분류 조건에는 기존 그룹 결과 열이 필요합니다.")
        elif self.similarity_method is not None or self.similarity_threshold is not None or (self.output and self.output.score_column_id):
            raise ValueError("유사도 방식·기준 점수와 점수 열은 거래처 매칭에서만 지정합니다.")
        if self.kind not in {"match_suppliers", "dimensions"} and (self.condition is not None or self.destination_column_id is not None):
            if self.kind != "set" or self.condition is None or self.destination_column_id is None:
                raise ValueError("조건부 값 변경에는 조건과 반영할 기존 열을 함께 지정하세요.")
            if self.column_ids != [self.condition.column_id]:
                raise ValueError("조건을 확인할 입력 열이 다릅니다.")
            if self.condition.operator == "contains" and not self.condition.value:
                raise ValueError("포함 여부를 확인할 문자열을 지정하세요.")
        if (self.kind == "set") != (self.assigned_value is not None):
            raise ValueError("값 지정 작업에는 적용할 값을 입력하세요. 빈 문자열도 사용할 수 있습니다.")
        if self.kind != "extract" and self.extraction_mode is not None:
            raise ValueError("추출 방식은 모델명 후보 찾기에서만 지정하세요.")
        if self.extraction_mode == "pdf" and self.output and self.output.mode == "existing":
            raise ValueError("PDF 추출은 모델명과 종류를 함께 저장합니다. 새 결과 열로 요청하세요.")
        if len(set(self.column_ids)) != len(self.column_ids):
            raise ValueError("대상 열이 중복되었습니다.")
        if self.kind == "group":
            if not self.value_column_id or self.value_column_id in self.column_ids:
                raise ValueError("같은 값 판단 기준과 값을 바꿀 열을 서로 다르게 지정하세요.")
            if len(self.column_ids) > 19:
                raise ValueError("같은 값 판단 기준은 최대 19열입니다.")
            if self.representative is not None and not self.representative.strip():
                raise ValueError("대표값은 빈 값일 수 없습니다.")
        elif self.value_column_id is not None or self.source_row is not None or self.representative is not None:
            raise ValueError("기준 행과 대표값은 같은 기준의 행에 대표값 적용에서만 사용합니다.")
        if self.group_mode != "manual":
            if self.kind != "group":
                raise ValueError("자동 대표값 선택은 그룹 작업에서만 사용합니다.")
            if self.source_row is not None or self.representative is not None:
                raise ValueError(
                    "자동 방식에서는 기준 행이나 대표값을 직접 지정하지 않습니다."
                )
        if self.kind != "split" and self.part != "all":
            raise ValueError("마지막 단어 추출은 문자열 분리에서만 사용합니다.")
        if self.kind != "group" and len(self.column_ids) != 1:
            raise ValueError("묶음 이외의 기능은 한 열을 선택하세요.")
        if self.kind == "preprocess":
            if not self.rules:
                raise ValueError("전처리 규칙을 선택하세요.")
            names = {rule.operation for rule in self.rules}
            if len(names) != len(self.rules):
                raise ValueError("같은 규칙은 한 번씩 선택하세요.")
            if {"uppercase", "lowercase"} <= names:
                raise ValueError("대문자와 소문자 통일은 하나만 선택하세요.")
        elif self.rules:
            raise ValueError("전처리 규칙은 전처리 기능에서만 지정할 수 있습니다.")
        if self.kind != "split" and self.delimiter is not None:
            raise ValueError("구분자는 문자열 분리에서만 사용합니다.")
        if self.kind != "replace" and (self.find is not None or self.replacement):
            raise ValueError("찾을 문자열과 바꿀 값은 치환에서만 사용합니다.")
        if self.find == "":
            raise ValueError(FIND_REQUIRED)
        if self.kind != "map" and self.mappings:
            raise ValueError("대표값 목록은 자동 매핑에서만 사용합니다.")
        keys = [mapping_key(item.source) for item in self.mappings]
        if any(not item.target.strip() for item in self.mappings):
            raise ValueError("대표값을 입력하세요.")
        if any(not key for key in keys) or len(set(keys)) != len(keys):
            raise ValueError("공백·대소문자 정리 후 같은 원본 값은 한 번만 매핑하세요. 빈 값은 매핑하지 않습니다.")
        return self

    def validate_ready(self):
        if self.kind == "extract" and self.extraction_mode is None:
            raise ValueError("추천을 확인하고 추출 방식을 선택하세요.")
        if self.kind == "replace" and self.find is None:
            raise ValueError(FIND_REQUIRED)
        if self.kind == "map" and not self.mappings:
            raise ValueError("원본 값과 대표값을 지정하세요.")
        if self.kind == "group" and self.group_mode == "manual" and self.source_row is None:
            raise ValueError("대표값의 기준이 되는 행을 지정하세요.")


class Row(StrictModel):
    excel_row: int = Field(ge=1, le=1048576)
    values: list[Text] = Field(min_length=1, max_length=100)


class OperationRequest(StrictModel):
    operation: Operation
    rows: list[Row] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def validate_rows(self):
        self.operation.validate_ready()
        if self.operation.kind != "group" and len(self.rows) > 10000:
            raise ValueError("묶음 이외의 기능은 최대 10,000행씩 요청하세요.")
        if len({row.excel_row for row in self.rows}) != len(self.rows):
            raise ValueError("행 번호가 중복되었습니다.")
        if any(len(row.values) != len(self.operation.input_column_ids) for row in self.rows):
            raise ValueError("대상 열 개수와 행의 값 개수가 다릅니다.")
        if sum(len(value) for row in self.rows for value in row.values) > 16000000:
            raise ValueError("처리할 문자열이 너무 많습니다. 대상 행을 줄여 주세요.")
        if self.operation.condition and self.operation.kind in {"set", "dimensions"}:
            condition = self.operation.condition
            index = self.operation.input_column_ids.index(condition.column_id)
            for row in self.rows:
                value = row.values[index]
                matched = condition.matches(value)
                if not matched:
                    raise ValueError("요청한 조건에 맞지 않는 행이 포함되어 있습니다.")
        return self


class OperationResponse(StrictModel):
    extracted_texts: list[Text] | None = None
    summary: str | None = None
    headers: list[str]
    rows: list[Row]
    changed_count: int


class WorkspaceColumn(StrictModel):
    column_id: ColumnId
    header: str = Field(max_length=256)
    role: str = Field(max_length=50)
    description: str = Field(default="", max_length=1000)


class SampleRow(StrictModel):
    excel_row: int = Field(ge=1, le=1048576)
    values: list[Annotated[str, Field(max_length=1000)]] = Field(min_length=1, max_length=20)
    truncated: bool = False


class SelectionStageSummary(StrictModel):
    stage_id: str
    parent_id: str | None = None
    origin_request_id: str | None = None
    request: ScopeRequest
    status: Literal["applied", "needs_review"]
    review_reason: str = ""
    input_count: int = Field(ge=0)
    selected_count: int = Field(ge=0)
    excluded_count: int = Field(ge=0)
    pending_count: int = Field(ge=0)
    at: str


class WorkspaceContext(StrictModel):
    selection_stages: list[SelectionStageSummary] = Field(default_factory=list)
    pending_operation: Operation | None = None
    row_start: int | None = Field(default=None, ge=0, lt=1048576)
    workspace_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    table_id: str = Field(min_length=1, max_length=256)
    task_type: TaskType
    sheet_name: str = Field(min_length=1, max_length=256)
    row_count: int = Field(ge=1, le=400000)
    columns: list[WorkspaceColumn] = Field(min_length=1, max_length=200)
    row_filter: RowScope | None = None
    review_required_column_ids: list[ColumnId] = Field(default_factory=list, max_length=200)
    advice_subject: Literal["model", "company"] = "company"
    target_column_ids: list[ColumnId] = Field(default_factory=list, max_length=20)
    last_result_column_ids: list[ColumnId] = Field(default_factory=list, max_length=100)
    sample_rows: list[SampleRow] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_columns(self):
        required = ({"declared_name", "trade_name", "model_spec"}
                    if self.task_type == "model_normalization"
                    else {"country_code", "party_code", "company_name"})
        if self.task_type == "investigation":
            required = set()
        ids = [column.column_id for column in self.columns]
        roles = [column.role for column in self.columns]
        if len(set(ids)) != len(ids) or any(roles.count(role) != 1 for role in required):
            raise ValueError("업무에 필요한 서로 다른 세 열을 확인하세요.")
        if self.row_filter and not set(self.row_filter.column_ids) <= set(ids):
            raise ValueError("조건 열이 삭제되었습니다. 작업 범위를 다시 지정하세요.")
        if any(len(row.values) != len(self.target_column_ids) for row in self.sample_rows):
            raise ValueError("표본의 열 수가 현재 대상과 다릅니다.")
        # 이전 화면의 대화 문맥에 삭제한 결과 열이 남아 있어도 다음 요청은 받는다.
        # 실제 연산의 열 검증은 OperationRequest와 Excel 쓰기 단계에서 유지한다.
        self.review_required_column_ids = [column_id for column_id in self.review_required_column_ids if column_id in ids]
        keep = [index for index, column_id in enumerate(self.target_column_ids) if column_id in ids]
        self.target_column_ids = [self.target_column_ids[index] for index in keep]
        self.last_result_column_ids = [column_id for column_id in self.last_result_column_ids if column_id in ids]
        self.sample_rows = [row.model_copy(update={"values": [row.values[index] for index in keep]})
                            for row in self.sample_rows] if keep else []
        return self
