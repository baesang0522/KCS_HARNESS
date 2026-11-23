"""Confirmed PDF suppliers against unique worksheet names; never compare worksheet names to each other."""
from services.errors import ConflictError
from services.operations.schemas import OperationResponse, Row, mapping_key
from services.similarity import score


def references(conversation, source):
    from services.investigation.schemas import SupplierTarget
    from services.investigation.service import same_workspace, source_issue
    state = conversation.investigation
    if not state.workspace or not same_workspace(state.workspace.model_dump(), source.model_dump()):
        raise ConflictError("PDF 조사와 같은 작업표에서 거래처를 비교하세요.")
    suppliers = [item for item in state.conditions if isinstance(item.target, SupplierTarget)]
    if not suppliers:
        raise ConflictError("먼저 해외거래처 PDF를 추출하고 검토 내용을 반영하세요.")
    result = []
    for item in suppliers:
        issue = source_issue(item, conversation, state.workspace)
        if issue or item.status != "confirmed":
            raise ConflictError(issue or "해외거래처 검토 내용의 수정 내용 반영을 먼저 완료하세요.")
        result.append({"group": item.target.category.strip() or item.target.company_name,
                       "company_name": item.target.company_name,
                       "condition_id": str(item.condition_id),
                       "document_id": str(item.source_document_id) if item.source_document_id else None,
                       "source_pages": list(item.source_pages)})
    return result


def validate_references(job, conversation):
    if job.source.operation.kind == "match_suppliers" and job.supplier_references != references(conversation, job.source):
        raise ConflictError("비교 후 기준 거래처 목록이나 순서가 바뀌었습니다. 새 미리보기를 확인하세요.")


def compare(rows, suppliers, method="auto", threshold=90):
    if method not in {"auto", "levenshtein", "sequence"}:
        raise ValueError("지원하지 않는 유사도 방식입니다.")
    if not suppliers:
        raise ConflictError("저장된 기준 거래처 목록이 없습니다. 새 비교를 요청하세요.")
    prepared = [(item["group"], mapping_key(item["company_name"])) for item in suppliers]
    matches = {}
    result = []
    for row in rows:
        value = row.values[0]
        if value not in matches:
            key = mapping_key(value)
            best, group = -1.0, ""
            if key:
                for algorithm in (["levenshtein", "sequence"] if method == "auto" else [method]):
                    best, group = -1.0, ""
                    for label, name in prepared:
                        current = score(key, name, algorithm)
                        # Equal scores deliberately select the later saved reference.
                        if current >= best:
                            best, group = current, label
                    if best >= threshold:
                        break
            matches[value] = [group if best >= threshold else "", format(best, ".6f").rstrip("0").rstrip(".") if best >= 0 else ""]
        result.append(Row(excel_row=row.excel_row, values=matches[value]))
    return OperationResponse(headers=["거래처 그룹", "유사도 점수"], rows=result,
                             changed_count=sum(row.values[0] != original.values[0] for row, original in zip(result, rows)))
