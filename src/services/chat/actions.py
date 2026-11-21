from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field
from services.operations.schemas import ColumnId, Rule
from services.formula.schemas import FormulaOutput

class DocumentAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["document_action"]
    action: Literal["apply", "retry", "preprocess"]
    document_id: UUID
    kind: Literal["supplier", "item", "other"] = "supplier"
    column: str = Field(default="회사명", min_length=1, max_length=200)
    rules: list[Rule] = Field(default_factory=list, max_length=10)


class WorkspaceAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["workspace_action"]
    column_id: ColumnId
    role: Literal["reference", "country_code", "party_code", "company_name", "declared_name", "trade_name", "model_spec"]


class FormulaOutputAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["formula_output"]
    formula_job_id: UUID
    output: FormulaOutput
