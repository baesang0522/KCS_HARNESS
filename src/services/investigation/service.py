"""조사 조건 저장·작업표 연결·검토 반영. 추출 완료 전 상태는 변경하지 않는다."""
import json
from services.documents.schemas import DocumentLink, DocumentWorkspace
from services.documents.service import find_document
from services.errors import ConflictError, DocumentError
from services.operations.schemas import WorkspaceColumn
from services.investigation.schemas import Condition, ItemTarget, OtherTarget, ReviewRow, SupplierTarget


def same_workspace(left, right):
    return bool(left and right and all(str(left.get(key)) == str(right.get(key))
                for key in ("workspace_id", "worksheet_id", "table_id")))


def check_revision(state, revision):
    if state.revision != revision:
        raise ConflictError("조사 조건이 갱신됐습니다. 새로 불러온 뒤 다시 저장하세요.")


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
    conversation.investigation = next_state
    return next_state


def investigation_context(conversation, workspace, review_sheets=None):
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
    documents = [document.summary() for document in conversation.documents.values()
                 if not document.link or not document.link.workspace or
                 same_workspace(document.link.workspace.model_dump(), workspace)]
    layouts = {"supplier": ("거래처검토", ["그룹명", "회사명", "근거 페이지"]),
               "item": ("품목검토", ["그룹", "HS", "규격", "조건", "근거 페이지"]),
               "other": ("조건검토", ["그룹", "내용", "근거 페이지"])}
    review_targets = []
    sheet_names = {(str(item["document_id"]), item["kind"]): item["sheet_name"] for item in (review_sheets or [])}
    for document in documents:
        did = document["document_id"]
        if did not in state.document_notes:
            continue
        rows = review_rows(state, did)
        kinds = {row.target.kind for row in rows} or {item.target.kind for item in state.extracted_conditions.get(did, []) if item.target}
        for kind in sorted(kinds):
            name, headers = layouts[kind]
            review_targets.append({"document_id": did, "filename": document["filename"], "kind": kind,
                "review_name": name, "sheet_name_prefix": name + "_", "sheet_name": sheet_names.get((did, kind)), "columns": headers,
                "saved_row_count": sum(row.target.kind == kind for row in rows)})
    return {"scope": "bound" if state.workspace else "unbound", "goal": state.goal,
            "active_condition_id": str(state.active_condition_id) if state.active_condition_id else None,
            "conditions": [item.model_dump(mode="json") for item in state.conditions],
            "document_notes": state.document_notes, "documents": documents, "review_targets": review_targets}



def belongs_to_document(condition, document_id):
    return str(condition.source_document_id) == document_id or any(str(e.document_id) == document_id for e in condition.evidence)


def review_rows(state, document_id):
    return [ReviewRow(target=item.target or OtherTarget(kind="other", group=str(index + 1), description=item.description),
                      source_pages=item.source_pages or sorted({e.page_number for e in item.evidence}))
            for index, item in enumerate(state.conditions) if belongs_to_document(item, document_id)]


def public_investigation(state):
    result = state.model_dump(mode="json", exclude={"extracted_conditions"})
    from services.investigation.bindings import condition_version
    result["condition_versions"] = {str(item.condition_id): condition_version(item) for item in state.conditions}
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
    previous = {}
    for item in state.conditions:
        if belongs_to_document(item, document_id) and item.target:
            previous.setdefault(row_key(ReviewRow(target=item.target, source_pages=item.source_pages)), []).append(item)
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
        unchanged = previous.get(row_key(row), [])
        if unchanged:
            old = unchanged.pop(0)
            condition.condition_id = old.condition_id
            condition.column_ids = list(old.column_ids)
        issue = source_issue(condition, conversation, state.workspace)
        if issue:
            raise ConflictError(issue)
        next_state.conditions.append(condition)
    if next_state.active_condition_id not in {item.condition_id for item in next_state.conditions}:
        next_state.active_condition_id = None
    next_state.revision += 1
    conversation.investigation = next_state
    return next_state
