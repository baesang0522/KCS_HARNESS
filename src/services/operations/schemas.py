"""화면과 자연어 요청이 공유하는 연산 계약."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Text = Annotated[str, Field(max_length=32767)]
ColumnId = Annotated[str, Field(min_length=1, max_length=256)]
TaskType = Literal["model_normalization", "counterparty_cleanup"]


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


class Rule(StrictModel):
    operation: Literal["trim", "collapse_whitespace", "normalize_fullwidth_ascii",
                       "uppercase", "lowercase", "remove_words"]
    words: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_words(self):
        if self.operation == "remove_words":
            if not self.words or any(not word.strip() for word in self.words):
                raise ValueError("제거할 단어를 입력하세요.")
        elif self.words:
            raise ValueError("단어 목록은 단어 제거에서만 사용합니다.")
        return self


class Operation(StrictModel):
    kind: Literal["preprocess", "split", "group", "replace", "map"]
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

    @property
    def input_column_ids(self) -> list[str]:
        return self.column_ids + ([self.value_column_id] if self.kind == "group" else [])

    @model_validator(mode="after")
    def validate_operation(self):
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
            raise ValueError("찾을 문자열이 비어 있습니다.")
        if self.kind != "map" and self.mappings:
            raise ValueError("대표값 목록은 자동 매핑에서만 사용합니다.")
        keys = [mapping_key(item.source) for item in self.mappings]
        if any(not item.target.strip() for item in self.mappings):
            raise ValueError("대표값을 입력하세요.")
        if any(not key for key in keys) or len(set(keys)) != len(keys):
            raise ValueError("공백·대소문자 정리 후 같은 원본 값은 한 번만 매핑하세요. 빈 값은 매핑하지 않습니다.")
        return self


class Row(StrictModel):
    excel_row: int = Field(ge=1, le=1048576)
    values: list[Text] = Field(min_length=1, max_length=100)


class OperationRequest(StrictModel):
    operation: Operation
    rows: list[Row] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def validate_rows(self):
        if self.operation.kind != "group" and len(self.rows) > 10000:
            raise ValueError("묶음 이외의 기능은 최대 10,000행씩 요청하세요.")
        if self.operation.kind == "replace" and self.operation.find is None:
            raise ValueError("찾을 문자열을 입력하세요.")
        if self.operation.kind == "map" and not self.operation.mappings:
            raise ValueError("원본 값과 대표값을 지정하세요.")
        if self.operation.kind == "group" and self.operation.source_row is None:
            raise ValueError("대표값의 기준이 되는 행을 지정하세요.")
        if len({row.excel_row for row in self.rows}) != len(self.rows):
            raise ValueError("행 번호가 중복되었습니다.")
        if any(len(row.values) != len(self.operation.input_column_ids) for row in self.rows):
            raise ValueError("대상 열 개수와 행의 값 개수가 다릅니다.")
        if sum(len(value) for row in self.rows for value in row.values) > 16000000:
            raise ValueError("처리할 문자열이 너무 많습니다. 대상 행을 줄여 주세요.")
        return self


class OperationResponse(StrictModel):
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


class WorkspaceContext(StrictModel):
    worksheet_id: str = Field(min_length=1, max_length=256)
    table_id: str = Field(min_length=1, max_length=256)
    task_type: TaskType
    sheet_name: str = Field(min_length=1, max_length=256)
    row_count: int = Field(ge=1, le=400000)
    columns: list[WorkspaceColumn] = Field(min_length=3, max_length=200)
    target_column_ids: list[ColumnId] = Field(default_factory=list, max_length=20)
    last_result_column_ids: list[ColumnId] = Field(default_factory=list, max_length=100)
    sample_rows: list[SampleRow] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_columns(self):
        required = ({"declared_name", "trade_name", "model_spec"}
                    if self.task_type == "model_normalization"
                    else {"country_code", "party_code", "company_name"})
        ids = [column.column_id for column in self.columns]
        roles = [column.role for column in self.columns]
        if len(set(ids)) != len(ids) or any(roles.count(role) != 1 for role in required):
            raise ValueError("업무에 필요한 서로 다른 세 열을 확인하세요.")
        if any(len(row.values) != len(self.target_column_ids) for row in self.sample_rows):
            raise ValueError("표본의 열 수가 현재 대상과 다릅니다.")
        # 이전 화면의 대화 문맥에 삭제한 결과 열이 남아 있어도 다음 요청은 받는다.
        # 실제 연산의 열 검증은 OperationRequest와 Excel 쓰기 단계에서 유지한다.
        keep = [index for index, column_id in enumerate(self.target_column_ids) if column_id in ids]
        self.target_column_ids = [self.target_column_ids[index] for index in keep]
        self.last_result_column_ids = [column_id for column_id in self.last_result_column_ids if column_id in ids]
        self.sample_rows = [row.model_copy(update={"values": [row.values[index] for index in keep]})
                            for row in self.sample_rows] if keep else []
        return self
