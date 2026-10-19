from collections import defaultdict
from difflib import SequenceMatcher
from itertools import combinations
from time import monotonic
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_PAIRS = 50000
MAX_SECONDS = 5


class SimilaritySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column_id: str = Field(min_length=1, max_length=256)
    group_column_id: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def validate_group(self):
        if self.group_column_id == self.column_id:
            raise ValueError("비교 대상과 비교 조건에는 서로 다른 열을 지정하세요.")
        return self

    @property
    def input_column_ids(self) -> list[str]:
        return [self.column_id] + ([self.group_column_id] if self.group_column_id else [])

    def check_workspace(self, workspace: dict | None) -> None:
        if not workspace:
            raise ValueError("먼저 작업 시트를 준비하세요.")
        known = {str(column["column_id"]) for column in workspace["columns"]}
        if not set(self.input_column_ids) <= known:
            raise ValueError("현재 작업 시트에 없는 열입니다.")


class SimilaritySettings(SimilaritySelection):
    method: Literal["levenshtein", "sequence"]


class SimilarityRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excel_row: int = Field(ge=1, le=1048576)
    value: str = Field(max_length=200)
    group: str = Field(default="", max_length=200)


class SimilarityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    settings: SimilaritySettings
    rows: list[SimilarityRow] = Field(min_length=1, max_length=400000)

    @model_validator(mode="after")
    def validate_rows(self):
        if len({row.excel_row for row in self.rows}) != len(self.rows):
            raise ValueError("검사 대상 행 번호가 중복되었습니다.")
        if sum(len(row.value) + len(row.group) for row in self.rows) > 8_000_000:
            raise ValueError("검사할 문자열이 너무 많습니다. 행 범위를 줄이세요.")
        return self


def score(a: str, b: str, method: str) -> float:
    if method == "levenshtein":
        from rapidfuzz.distance import Levenshtein
        return 100 * Levenshtein.normalized_similarity(a, b)
    forward = SequenceMatcher(None, a, b, autojunk=False).ratio()
    backward = SequenceMatcher(None, b, a, autojunk=False).ratio()
    return 50 * (forward + backward)


def inspect_similarity(payload: SimilarityRequest) -> dict:
    groups = defaultdict(dict)
    skipped = 0
    for row in payload.rows:
        if not row.value.strip() or (payload.settings.group_column_id is not None and not row.group.strip()):
            skipped += 1
            continue
        group = row.group if payload.settings.group_column_id is not None else ""
        groups[group].setdefault(row.value, []).append(row.excel_row)

    pair_count = sum(len(items) * (len(items) - 1) // 2 for items in groups.values())
    if pair_count > MAX_PAIRS:
        raise ValueError(
            f"예상 비교 {pair_count:,}쌍이 한도 {MAX_PAIRS:,}쌍을 넘었습니다. "
            "행 범위를 줄이거나 비교 조건 열을 선택하세요."
        )

    deadline = monotonic() + MAX_SECONDS
    matches = []
    for group, items in groups.items():
        for a, b in combinations(sorted(items), 2):
            if monotonic() > deadline:
                raise ValueError("계산 시간 한도를 넘었습니다. 검사 범위를 줄이세요.")
            value = score(a, b, payload.settings.method)
            if monotonic() > deadline:
                raise ValueError("계산 시간 한도를 넘었습니다. 검사 범위를 줄이세요.")
            matches.append({
                "base": a, "base_count": len(items[a]),
                "candidate": b, "candidate_count": len(items[b]),
                "score": value, "group": group,
                "base_row": items[a][0], "candidate_row": items[b][0],
            })

    return {
        "rows": matches,
        "input_rows": len(payload.rows),
        "skipped_rows": skipped,
        "unique_values": sum(len(items) for items in groups.values()),
        "pair_count": pair_count,
    }
