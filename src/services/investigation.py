"""대화 수명 동안 유지하는 조사 조건. 셀 선별이나 쓰기는 수행하지 않는다."""
import asyncio
import json
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import Field, model_validator

from prompts.loader import load_agent_prompt
from services.documents.schemas import DocumentLink, DocumentWorkspace
from services.documents.service import find_document
from services.errors import ConflictError, DocumentError, ModelProcessingError
from services.operations.schemas import ColumnId, StrictModel, WorkspaceColumn, WorkspaceContext
from services.recommendation.model_io import ask


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
    category: RequiredText
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
    expected_rows: list[ReviewRow] = Field(max_length=100)
    rows: list[ReviewRow] = Field(max_length=100)


class Candidate(StrictModel):
    target: Target
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    evidence: list[SourceReference] = Field(min_length=1, max_length=12)
    uncertainty: str = Field(default="", max_length=1000)


class Extraction(StrictModel):
    conditions: list[Candidate] = Field(max_length=50)
    warnings: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=10)


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
    conditions: list[ConditionInput] = Field(max_length=100)
    active_condition_id: UUID | None = None
    workspace: WorkspaceContext | None = None
    bind_workspace: bool = False


class ExtractConditions(StrictModel):
    document_id: UUID
    revision: int = Field(ge=0)


def same_workspace(left, right):
    return bool(left and right and all(str(left.get(key)) == str(right.get(key))
                for key in ("workspace_id", "worksheet_id", "table_id")))


def check_revision(state, revision):
    if state.revision != revision:
        raise ConflictError("조사 조건이 갱신됐습니다. 새로 불러온 뒤 다시 저장하세요.")


def validate_size(state):
    if len(state.conditions) > 100 or len(state.model_dump_json().encode("utf-8")) > 64000:
        raise DocumentError("조사 조건은 최대 100개·64KB입니다. 조건을 정리하거나 새 대화를 시작하세요.")


def invalidate_document(conversation, document_id):
    state = conversation.investigation
    affected = False
    for condition in state.conditions:
        if belongs_to_document(condition, document_id):
            condition.status = "needs_review"
            condition.review_reason = "근거 문서가 제거되거나 연결이 변경됐습니다."
            affected = True
    if affected:
        state.revision += 1


def source_issue(condition, conversation, workspace):
    document_ids = {str(evidence.document_id) for evidence in condition.evidence}
    if condition.source_document_id:
        document_ids.add(str(condition.source_document_id))
    for document_id in document_ids:
        document = conversation.documents.get(document_id)
        if document is None:
            return "근거 문서가 제거됐습니다. 자료를 확인하고 조건을 다시 추가하세요."
        linked = document.link.workspace if document.link else None
        if workspace and linked and not same_workspace(workspace.model_dump(), linked.model_dump()):
            return "근거 문서가 다른 작업표에 연결되어 있습니다."
    return ""


def save_investigation(conversation, payload):
    state = conversation.investigation
    check_revision(state, payload.revision)
    next_state = state.model_copy(deep=True)
    if not payload.goal.strip():
        raise DocumentError("조사 목표를 입력하세요.")
    next_state.goal = payload.goal.strip()
    current = payload.workspace
    changed_workspace = False
    if payload.bind_workspace:
        if current is None:
            raise DocumentError("먼저 연결할 작업표를 준비하세요.")
        changed_workspace = bool(state.workspace and not same_workspace(state.workspace.model_dump(), current.model_dump()))
        next_state.workspace = DocumentWorkspace.model_validate(current.model_dump(include=set(DocumentWorkspace.model_fields)))
    if next_state.workspace:
        if current is None or not same_workspace(next_state.workspace.model_dump(), current.model_dump()):
            raise ConflictError("조사에 연결된 작업표를 열거나 현재 작업표로 연결을 변경하세요.")
        next_state.columns = current.columns
    else:
        next_state.columns = []
    known = {column.column_id for column in next_state.columns}
    previous = {item.condition_id: item for item in state.conditions}
    seen, conditions = set(), []
    for item in payload.conditions:
        if item.condition_id is not None:
            if item.condition_id not in previous or item.condition_id in seen:
                raise DocumentError("현재 조사에 없는 조건이거나 중복된 조건입니다.")
            seen.add(item.condition_id)
            condition = previous[item.condition_id].model_copy(deep=True)
        else:
            condition = Condition(title=item.title, description=item.description, edited=True)
        if not set(item.column_ids) <= known and not changed_workspace:
            raise DocumentError("연결할 열이 없거나 삭제됐습니다. 열 연결을 다시 선택하세요.")
        if condition.target and condition.description != item.description:
            condition.target = OtherTarget(kind="other", group=condition.target.group, description=item.description)
        condition.edited |= condition.title != item.title or condition.description != item.description
        condition.title, condition.description = item.title, item.description
        condition.column_ids = [] if changed_workspace else item.column_ids
        issue = source_issue(condition, conversation, next_state.workspace)
        if issue and item.status == "confirmed" and not changed_workspace:
            raise ConflictError(issue)
        condition.status = "needs_review" if changed_workspace or issue else item.status
        condition.review_reason = "작업표가 바뀌었습니다. 연결할 열을 다시 선택하세요." if changed_workspace else issue
        conditions.append(condition)
    if payload.active_condition_id and payload.active_condition_id not in {item.condition_id for item in conditions}:
        raise DocumentError("현재 검토 조건이 삭제되었거나 다른 조사에 속합니다.")
    next_state.conditions = conditions
    next_state.active_condition_id = payload.active_condition_id
    next_state.revision += 1
    validate_size(next_state)
    conversation.investigation = next_state
    return next_state


def evidence_sources(document):
    pages, sources = [], {}
    for page in document.pages:
        if not page.readable:
            continue
        parts = [line[start:start + 2000] for line in page.text.splitlines() if line.strip()
                 for start in range(0, len(line), 2000) if line[start:start + 2000].strip()]
        entries = []
        for source_id, text in enumerate(parts, 1):
            sources[(page.page_number, source_id)] = text
            entries.append({"source_id": source_id, "text": text})
        pages.append({"page_number": page.page_number, "sources": entries})
    return pages, sources


async def extract_conditions(conversation, payload, runtime, request_id):
    state = conversation.investigation
    check_revision(state, payload.revision)
    document_id = str(payload.document_id)
    document = find_document(conversation, document_id)
    if document_id in state.document_notes:
        return state  # 사용자의 수정·삭제를 다시 추출한 내용으로 덮어쓰지 않는다.
    if document.link and document.link.workspace and state.workspace and not same_workspace(
            document.link.workspace.model_dump(), state.workspace.model_dump()):
        raise ConflictError("문서와 조사의 연결 작업표가 다릅니다. 연결을 확인하세요.")
    pages, sources = evidence_sources(document)
    prompt = load_agent_prompt(Path(__file__).resolve().parents[1] / "prompts/investigation.yml").render()
    data = {"goal": state.goal, "filename": document.filename, "pages": pages,
            "response_schema": Extraction.model_json_schema()}
    # shortcut: 첫 PoC는 문서 전체를 한 번에 읽는다. 큰 문서가 필요하면 근거를 유지하는 분할 추출을 추가한다.
    if len((prompt + json.dumps(data, ensure_ascii=False)).encode("utf-8")) > 48000:
        raise DocumentError("조사 조건 추출 입력이 48KB를 넘습니다. 필요한 부분으로 PDF를 나눠 첨부하세요. 본문은 임의로 생략하지 않습니다.")
    try:
        extracted = await asyncio.wait_for(
            ask(runtime.advice_model, prompt, "conditions", data, Extraction),
            timeout=runtime.settings.llm.timeout_seconds + 10)
    except Exception as error:
        raise ModelProcessingError("조사 조건 응답을 확인하지 못했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.") from error
    next_state = state.model_copy(deep=True)
    for candidate in extracted.conditions:
        if not candidate.title.strip() or not candidate.description.strip():
            raise ModelProcessingError("빈 조사 조건이 반환되어 저장하지 않았습니다.")
        evidence = []
        for item in candidate.evidence:
            quote = sources.get((item.page_number, item.source_id))
            if quote is None:
                raise ModelProcessingError(
                    f"AI가 ‘{candidate.title}’의 근거 위치를 잘못 지정했습니다 "
                    f"({item.page_number}쪽, 구절 {item.source_id}). PDF는 유지했으며 조건은 저장하지 않았습니다. 추출 다시 시도를 눌러 주세요.")
            evidence.append(Evidence(page_number=item.page_number, quote=quote,
                                     document_id=document.document_id, filename=document.filename))
        next_state.conditions.append(Condition(**candidate.model_dump(exclude={"evidence"}), evidence=evidence,
            source_document_id=document.document_id, source_pages=sorted({item.page_number for item in evidence})))
    if request_id in conversation.cancelled_requests:
        raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
    next_state.extracted_conditions[document_id] = [item.model_copy(deep=True) for item in next_state.conditions
                                                   if belongs_to_document(item, document_id)]
    next_state.document_notes[document_id] = extracted.warnings + [
        f"{page.page_number}쪽은 읽을 수 있는 텍스트가 없습니다." for page in document.pages if not page.readable]
    next_state.revision += 1
    validate_size(next_state)
    conversation.investigation = next_state
    return next_state


def investigation_context(conversation, workspace):
    state = conversation.investigation
    if state.workspace and not same_workspace(state.workspace.model_dump(), workspace):
        return {"scope": "different_workspace", "notice": "다른 작업표의 조사 조건은 전달하지 않았습니다."}
    changed = False
    if state.workspace and workspace:
        columns = [WorkspaceColumn.model_validate(column) for column in workspace["columns"]]
        if state.columns != columns:
            state.columns = columns
            changed = True
    known = {column["column_id"] for column in workspace["columns"]} if workspace else set()
    for condition in state.conditions:
        issue = source_issue(condition, conversation, state.workspace)
        if state.workspace and not set(condition.column_ids) <= known:
            issue = "연결한 열이 삭제됐습니다. 조사 조건의 열 연결을 확인하세요."
        if issue and (condition.status != "needs_review" or condition.review_reason != issue):
            condition.status, condition.review_reason = "needs_review", issue
            changed = True
    if changed:
        state.revision += 1
    return {"scope": "bound" if state.workspace else "unbound", "goal": state.goal,
            "active_condition_id": str(state.active_condition_id) if state.active_condition_id else None,
            "conditions": [item.model_dump(mode="json") for item in state.conditions],
            "document_notes": state.document_notes,
            "documents": [document.summary() for document in conversation.documents.values()
                          if not document.link or not document.link.workspace or
                          same_workspace(document.link.workspace.model_dump(), workspace)]}


def belongs_to_document(condition, document_id):
    return str(condition.source_document_id) == document_id or any(str(e.document_id) == document_id for e in condition.evidence)


def review_rows(state, document_id):
    return [ReviewRow(target=item.target or OtherTarget(kind="other", group=str(index + 1), description=item.description),
                      source_pages=item.source_pages or sorted({e.page_number for e in item.evidence}))
            for index, item in enumerate(state.conditions) if belongs_to_document(item, document_id)]


def public_investigation(state):
    result = state.model_dump(mode="json", exclude={"extracted_conditions"})
    result["reviews"] = {did: [row.model_dump(mode="json") for row in review_rows(state, did)] for did in state.document_notes}
    return result


def bind_investigation(conversation, workspace):
    state = conversation.investigation
    if state.workspace and not same_workspace(state.workspace.model_dump(), workspace.model_dump()):
        raise ConflictError("이 대화는 다른 작업표로 조사 중입니다. 새 조사는 새 대화에서 시작하세요.")
    for document in conversation.documents.values():
        linked = document.link.workspace if document.link else None
        if linked and not same_workspace(linked.model_dump(), workspace.model_dump()):
            raise ConflictError("다른 작업표의 문서가 있습니다. 새 대화에서 시작하세요.")
    if state.workspace != workspace:
        state.workspace = workspace
        state.revision += 1
    for document in conversation.documents.values():
        document.link = DocumentLink(task_type=workspace.task_type, workspace=workspace)
    return state


def row_key(row):
    value = row.model_dump(mode="json")
    value["source_pages"] = sorted(set(value["source_pages"]))
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def target_description(target):
    if isinstance(target, SupplierTarget):
        return target.company_name, f"그룹 {target.group} / {target.category}: {target.company_name}"
    if isinstance(target, ItemTarget):
        return target.specification or "품목 조건", " / ".join(filter(None, [f"그룹 {target.group}",
            "HS " + " 또는 ".join(target.hs_codes) if target.hs_codes else "", target.specification, target.requirements]))
    return "기타 조건", target.description


def save_review(conversation, document_id, payload):
    state = conversation.investigation
    check_revision(state, payload.revision)
    document = find_document(conversation, document_id)
    if document_id not in state.document_notes:
        raise ConflictError("먼저 PDF 추출을 완료하세요.")
    current = review_rows(state, document_id)
    if sorted(map(row_key, current)) != sorted(map(row_key, payload.expected_rows)):
        raise ConflictError("이 검토 시트를 만든 뒤 서버의 내용이 바뀌었습니다. 수정한 시트는 유지했습니다. 현재 추출 내용을 확인하세요.")
    originals = {row_key(ReviewRow(target=item.target, source_pages=item.source_pages)): item
                 for item in state.extracted_conditions.get(document_id, []) if item.target}
    next_state = state.model_copy(deep=True)
    next_state.conditions = [item for item in next_state.conditions if not belongs_to_document(item, document_id)]
    for row in payload.rows:
        if any(not any(page.page_number == number and page.readable for page in document.pages) for number in row.source_pages):
            raise DocumentError("근거 페이지가 문서에 없거나 읽을 수 없는 페이지입니다.")
        original = originals.get(row_key(row))
        title, description = target_description(row.target)
        condition = Condition(title=title, description=description, target=row.target,
            source_document_id=document.document_id, source_pages=sorted(set(row.source_pages)),
            evidence=original.evidence if original else [], uncertainty=original.uncertainty if original else "",
            status="confirmed", edited=original is None)
        issue = source_issue(condition, conversation, state.workspace)
        if issue:
            raise ConflictError(issue)
        next_state.conditions.append(condition)
    if next_state.active_condition_id not in {item.condition_id for item in next_state.conditions}:
        next_state.active_condition_id = None
    next_state.revision += 1
    validate_size(next_state)
    conversation.investigation = next_state
    return next_state
