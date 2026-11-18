"""대화 수명 동안 유지하는 조사 조건. 셀 선별이나 쓰기는 수행하지 않는다."""
import asyncio
import json
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import Field, model_validator

from prompts.loader import load_agent_prompt
from services.documents.schemas import DocumentWorkspace
from services.documents.service import find_document
from services.errors import ConflictError, DocumentError, ModelProcessingError
from services.operations.schemas import ColumnId, StrictModel, WorkspaceColumn, WorkspaceContext
from services.recommendation.model_io import ask


class PageEvidence(StrictModel):
    page_number: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=2000)


class Candidate(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    evidence: list[PageEvidence] = Field(min_length=1, max_length=6)
    uncertainty: str = Field(default="", max_length=1000)


class Extraction(StrictModel):
    conditions: list[Candidate] = Field(max_length=50)
    warnings: list[Annotated[str, Field(max_length=1000)]] = Field(default_factory=list, max_length=10)


class Evidence(PageEvidence):
    document_id: UUID
    filename: str


class Condition(StrictModel):
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
        if any(str(item.document_id) == document_id for item in condition.evidence):
            condition.status = "needs_review"
            condition.review_reason = "근거 문서가 제거되거나 연결이 변경됐습니다."
            affected = True
    if affected:
        state.revision += 1


def source_issue(condition, conversation, workspace):
    for evidence in condition.evidence:
        document = conversation.documents.get(str(evidence.document_id))
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
    pages = [page.model_dump() for page in document.pages if page.readable]
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
            page = next((page for page in document.pages if page.page_number == item.page_number and page.readable), None)
            quote = " ".join(item.quote.split())
            if not quote or page is None or quote not in " ".join(page.text.split()):
                raise ModelProcessingError("조사 조건의 페이지·근거 문구가 원문과 맞지 않아 저장하지 않았습니다. 다시 읽어 주세요.")
            evidence.append(Evidence(**item.model_dump(), document_id=document.document_id, filename=document.filename))
        next_state.conditions.append(Condition(**candidate.model_dump(exclude={"evidence"}), evidence=evidence))
    if request_id in conversation.cancelled_requests:
        raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
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
