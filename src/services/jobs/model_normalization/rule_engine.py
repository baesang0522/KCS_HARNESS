import re
from collections.abc import Sequence


from services.jobs.model_normalization.schemas import (
    NormalizationPreview,
    NormalizationRow,
    Operation,
    PreviewRow,
    RuleSet
)


WHITESPACE_RUN = re.compile(r"\s+")


def apply_rule(value: str, operation: Operation) -> str:
    if operation == "trim":
        return value.strip()

    if operation == "collapse_whitespace":
        return WHITESPACE_RUN.sub(" ", value)

    raise ValueError(f"지원하지 않는 정제 규칙입니다.: {operation}")


def normalize_model_spec(
    value: str,
    rule_set: RuleSet,
) -> tuple[str, tuple[Operation, ...]]:
    current = value
    applied: list[Operation] = []

    for rule in rule_set.rules:
        updated = apply_rule(current, rule.operation)

        if updated != current:
            applied.append(rule.operation)

        current = updated
    return current, tuple(applied)


def build_preview(
    rows: Sequence[NormalizationRow],
    rule_set: RuleSet,
) -> NormalizationPreview:
    results: list[PreviewRow] = []

    for row in rows:
        normalized, applied = normalize_model_spec(row.model_spec, rule_set)
        results.append(
            PreviewRow(
                excel_row=row.excel_row,
                trade_name=row.trade_name,
                declared_name=row.declared_name,
                original_model_spec=row.model_spec,
                normalized_model_spec=normalized,
                changed=normalized != row.model_spec,
                applied_operations=applied,
            )
        )

    return NormalizationPreview(
        rule_set=rule_set,
        row_count=len(results),
        changed_count=sum(row.changed for row in results),
        rows=tuple(results),
    )
