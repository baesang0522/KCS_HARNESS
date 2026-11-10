"""조언에 사용할 조합의 집계·선정과 비교용 정렬 기준."""
from services.errors import SHARED_MESSAGES
import re
import unicodedata

from services.recommendation.schemas import AdviceRequest, TOP_COMBINATIONS


MODEL_GROUP_ROLES = ("declared_name", "trade_name", "model_spec")


def comparison_key(value: str) -> str:
    # 후보 정렬용이며 원문과 실제 셀은 변경하지 않는다.
    return re.sub(
        r"\W+",
        "",
        unicodedata.normalize("NFKC", value).casefold(),
    )


def top_model_combinations(data: AdviceRequest, columns: list[dict]) -> tuple[list[dict], dict]:
    indexes = []
    for role in MODEL_GROUP_ROLES:
        matches = [i for i, column in enumerate(columns) if column.get("role") == role]
        if len(matches) != 1:
            raise ValueError(SHARED_MESSAGES["ADVICE_GROUP_COLUMNS_REQUIRED"])
        indexes.append(matches[0])

    if data.selection is not None:
        if data.selection.group_column_ids != [columns[i]["column_id"] for i in indexes]:
            raise ValueError("집계 기준은 신고품명·거래품명·모델규격명이어야 합니다.")
        return [
            {"excel_row": row.excel_row, "values": [value.upper() for value in row.values], "count": row.count}
            for row in data.rows
        ], data.selection.model_dump()

    groups = {}
    for row in data.rows:
        key = tuple(row.values[i].upper() for i in indexes)
        if key not in groups:
            groups[key] = {"row": row, "count": 0}
        groups[key]["count"] += 1

    selected = sorted(groups.values(), key=lambda item: (-item["count"], item["row"].excel_row))[:TOP_COMBINATIONS]
    # shortcut: 추가 열은 첫 실제 행의 예시만 제공한다. 그룹 내 차이 분석이 필요하면 별도 집계를 추가한다.
    rows = [
        {"excel_row": item["row"].excel_row,
         "values": [value.upper() for value in item["row"].values],
         "count": item["count"]}
        for item in selected
    ]
    return rows, {
        "mode": "uppercase_top_combinations",
        "group_column_ids": [columns[i]["column_id"] for i in indexes],
        "total_rows": data.row_count,
        "total_combinations": len(groups),
        "selected_combinations": len(rows),
        "represented_rows": sum(row["count"] for row in rows),
        "additional_values": "first_row_example_only",
    }


