"""PDF의 확인된 모델명과 분류를 작업표 문자열에서 찾는다."""
import re

from services.errors import ConflictError
from services.investigation.schemas import ItemTarget
from services.investigation.service import same_workspace, source_issue
from services.operations.schemas import OperationResponse, Row, mapping_key


def references(conversation, source):
    state = conversation.investigation
    if not state.workspace or not same_workspace(state.workspace.model_dump(), source.model_dump()):
        raise ConflictError("PDF 조사와 같은 작업표에서 모델명을 추출하세요.")
    models = [item for item in state.conditions
              if isinstance(item.target, ItemTarget) and item.target.specification.strip()]
    if not models:
        raise ConflictError("먼저 모델명 PDF를 추출하고 검토 내용을 반영하세요.")
    result = []
    for item in models:
        issue = source_issue(item, conversation, state.workspace)
        if issue or item.status != "confirmed":
            raise ConflictError(issue or "모델명 PDF 검토 내용의 수정 내용 반영을 먼저 완료하세요.")
        result.append({"model": item.target.specification, "category": item.target.group,
                       "requirements": item.target.requirements, "hs_codes": list(item.target.hs_codes),
                       "condition_id": str(item.condition_id),
                       "document_id": str(item.source_document_id) if item.source_document_id else None,
                       "source_pages": list(item.source_pages)})
    return result


def validate_references(job, conversation):
    if job.source.operation.extraction_mode == "pdf" and job.model_references != references(conversation, job.source):
        raise ConflictError("추출 후 PDF 모델명이나 분류가 바뀌었습니다. 새 미리보기를 확인하세요.")


def compare(rows, models):
    if not models:
        raise ConflictError("확인한 PDF 모델명 목록이 없습니다. 새 추출을 요청하세요.")
    patterns = {}
    for item in models:
        key = mapping_key(item["model"])
        if key:
            # 하이픈·소수점까지 모델 표기의 일부로 보아 SA516과 SA516-70을 혼동하지 않는다.
            patterns.setdefault(key, re.compile(r"(?<![\w.\-])" + re.escape(key) + r"(?![\w.\-])"))
    cache, result = {}, []
    for row in rows:
        value = mapping_key(row.values[0])
        if value not in cache:
            hits = sorted((match.start(), -match.end(), key)
                          for key, pattern in patterns.items() for match in pattern.finditer(value))
            found, end = set(), -1
            for start, negative_end, key in hits:
                # 긴 모델명 안에 포함된 짧은 이름은 별도 모델로 중복 추출하지 않는다.
                if -negative_end > end:
                    found.add(key)
                    end = -negative_end
            pairs = list(dict.fromkeys((item["model"], item["category"]) for item in models
                                      if mapping_key(item["model"]) in found))
            cache[value] = ["\n".join(pair[i] for pair in pairs) for i in range(2)]
        result.append(Row(excel_row=row.excel_row, values=cache[value]))
    return OperationResponse(headers=["모델명", "모델명 종류"], rows=result,
                             changed_count=sum(bool(row.values[0]) for row in result))
