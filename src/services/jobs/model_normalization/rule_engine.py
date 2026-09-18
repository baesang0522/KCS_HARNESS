from collections.abc import Sequence

import pandas as pd

from services.jobs.model_normalization.schemas import (
    NormalizationPreview,
    NormalizationRow,
    Operation,
    PreviewRow,
    RuleSet,
)
from utils.dataframe_utils import (
    text_rows_to_dataframe,
    normalize_fullwidth_ascii,
)


def apply_rule(
    values: pd.Series,
    operation: Operation,
) -> pd.Series:
    """한 규칙을 전체 문자열 열에 적용한다."""
    if operation == "trim":
        return values.str.strip()

    if operation == "collapse_whitespace":
        return values.str.replace(r"\s+", " ", regex=True)

    if operation == "normalize_fullwidth_ascii":
        return normalize_fullwidth_ascii(values)

    raise ValueError(
        f"지원하지 않는 정제 규칙입니다: {operation}"
    )


def build_preview(
    rows: Sequence[NormalizationRow],
    rule_set: RuleSet,
) -> NormalizationPreview:
    dataframe = text_rows_to_dataframe(
        rows=(
            (
                row.trade_name,
                row.declared_name,
                row.model_spec,
            )
            for row in rows
        ),
        columns=(
            "trade_name",
            "declared_name",
            "original_model_spec",
        ),
    )
    dataframe.insert(
        0,
        "excel_row",
        [row.excel_row for row in rows],
    )

    current = dataframe["original_model_spec"]

    # 각 규칙이 실제로 값을 바꾼 행을 기록한다.
    # 중복 규칙과 규칙 순서도 기존 동작대로 보존한다.
    operation_changes: list[tuple[Operation, list[bool]]] = []

    for rule in rule_set.rules:
        updated = apply_rule(current, rule.operation)

        operation_changes.append(
            (
                rule.operation,
                current.ne(updated).tolist(),
            )
        )

        current = updated

    dataframe["normalized_model_spec"] = current
    dataframe["changed"] = (
        dataframe["original_model_spec"].ne(dataframe["normalized_model_spec"])
    )

    results = []

    # JSON 문자열을 거치지 않고 기존 응답 DTO로 변환한다.
    for index, row in enumerate(
        dataframe.itertuples(index=False)
    ):
        applied_operations = tuple(
            operation
            for operation, changed_rows in operation_changes
            if changed_rows[index]
        )

        results.append(
            PreviewRow(
                excel_row=int(row.excel_row),
                trade_name=row.trade_name,
                declared_name=row.declared_name,
                original_model_spec=row.original_model_spec,
                normalized_model_spec=row.normalized_model_spec,
                changed=bool(row.changed),
                applied_operations=applied_operations,
            )
        )

    return NormalizationPreview(
        rule_set=rule_set,
        row_count=len(dataframe),
        changed_count=int(dataframe["changed"].sum()),
        rows=tuple(results),
    )