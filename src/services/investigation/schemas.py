"""조사 조건·근거·검토 입력과 저장 상태."""
from typing import Annotated, Literal
from uuid import UUID, uuid4
from pydantic import Field, model_validator
from services.documents.schemas import DocumentWorkspace
from services.operations.schemas import ColumnId, StrictModel, WorkspaceColumn, WorkspaceContext


class PageEvidence(StrictModel):
    page_number: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=2000)


class SourceReference(StrictModel):
    page_number: int = Field(ge=1)
    source_id: int = Field(ge=1)


RequiredText = Annotated[str, Field(min_length=1, max_length=1000, pattern=r"\S")]


class SupplierTarget(StrictModel):
    kind: Literal["supplier"]
    group: RequiredText
    category: str = Field(max_length=1000)
    company_name: RequiredText


class ItemTarget(StrictModel):
    kind: Literal["item"]
    group: RequiredText
    hs_codes: list[Annotated[str, Field(pattern=r"^[0-9.]{4,14}$")]] = Field(max_length=20)
    specification: str = Field(max_length=1000)
    requirements: str = Field(max_length=2000)

    @model_validator(mode="after")
    def not_empty(self):
        if not (self.hs_codes or self.specification.strip() or self.requirements.strip()):
            raise ValueError("품목의 HS, 규격, 조건 중 하나는 입력하세요.")
        return self


class OtherTarget(StrictModel):
    kind: Literal["other"]
    group: RequiredText
    description: str = Field(min_length=1, max_length=2000, pattern=r"\S")


Target = Annotated[SupplierTarget | ItemTarget | OtherTarget, Field(discriminator="kind")]


class ReviewRow(StrictModel):
    target: Target
    source_pages: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list, max_length=20)


class SaveReview(StrictModel):
    revision: int = Field(ge=0)
    expected_rows: list[ReviewRow]
    rows: list[ReviewRow]


class Candidate(StrictModel):
    target: Target
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    evidence: list[SourceReference] = Field(min_length=1, max_length=12)
    uncertainty: str = Field(default="", max_length=1000)


class Extraction(StrictModel):
    conditions: list[Candidate]
    continuation_sources: list[SourceReference] = Field(default_factory=list)
    warnings: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=10)


class CatalogRule(StrictModel):
    table_ids: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)
    specifications: list[str] = Field(default_factory=list)
    row_numbers: list[str] = Field(default_factory=list)
    hs_codes: list[Annotated[str, Field(pattern=r"^[0-9.]{4,14}$")]] = Field(default_factory=list)
    requirements: str = ""
    evidence: list[SourceReference] = Field(min_length=1)
    uncertainty: str = ""


class CatalogExtraction(Extraction):
    table_rules: list[CatalogRule]


class Evidence(PageEvidence):
    document_id: UUID
    filename: str


class Condition(StrictModel):
    target: Target | None = None
    source_document_id: UUID | None = None
    source_pages: list[int] = Field(default_factory=list)
    condition_id: UUID = Field(default_factory=uuid4)
    title: str
    description: str
    evidence: list[Evidence] = Field(default_factory=list)
    uncertainty: str = ""
    status: Literal["candidate", "confirmed", "needs_review"] = "candidate"
    edited: bool = False
    column_ids: list[str] = Field(default_factory=list)
    review_reason: str = ""


class InvestigationState(StrictModel):
    revision: int = 0
    goal: str = "PDF에 나온 대상에 대응하는 데이터를 찾아 결과를 확인한다."
    workspace: DocumentWorkspace | None = None
    columns: list[WorkspaceColumn] = Field(default_factory=list)
    active_condition_id: UUID | None = None
    conditions: list[Condition] = Field(default_factory=list)
    document_notes: dict[str, list[str]] = Field(default_factory=dict)
    extracted_conditions: dict[str, list[Condition]] = Field(default_factory=dict)


class ConditionInput(StrictModel):
    condition_id: UUID | None = None
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    status: Literal["candidate", "confirmed", "needs_review"] = "candidate"
    column_ids: list[ColumnId] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check_text(self):
        if not self.title.strip() or not self.description.strip():
            raise ValueError("조건 이름과 내용을 입력하세요.")
        if len(set(self.column_ids)) != len(self.column_ids):
            raise ValueError("연결한 열이 중복되었습니다.")
        return self


class SaveInvestigation(StrictModel):
    revision: int = Field(ge=0)
    goal: str = Field(min_length=1, max_length=2000)
    conditions: list[ConditionInput]
    active_condition_id: UUID | None = None
    workspace: WorkspaceContext | None = None
    bind_workspace: bool = False


class ExtractConditions(StrictModel):
    document_id: UUID
    revision: int = Field(ge=0)
