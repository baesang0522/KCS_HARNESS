from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


