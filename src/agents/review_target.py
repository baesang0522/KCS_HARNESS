"""명시한 작업표·PDF 검토 대상을 서로 바꾸지 않도록 도구 호출을 검사한다."""
import re


def requested_review_kind(context):
    if context.get("agent_execution"):
        return None
    request = re.sub(r"\s+", "", context.get("user_request", ""))
    for target in (context.get("investigation") or {}).get("review_targets", []):
        name = re.sub(r"\s+", "", target.get("sheet_name") or "")
        if name and name in request and not any(word in request for word in ["작업표", "작업시트"]):
            return target["kind"]
    # When both surfaces are named, let the model resolve the requested comparison or destination.
    without_negation = re.sub(r"(?:작업표|작업시트)(?:가|이|는|에서)?(?:말고|아니라|아닌)", "", request)
    if "작업표" in without_negation or "작업시트" in without_negation:
        return None
    for name, kind in [("거래처검토", "supplier"), ("품목검토", "item"), ("조건검토", "other")]:
        if name in request:
            return kind
    has_suppliers = any(item["kind"] == "supplier" for item in
                        (context.get("investigation") or {}).get("review_targets", []))
    if has_suppliers and ("추출된회사명" in request or "추출한회사명" in request):
        return "supplier"
    return None


def check_review_tool(context, name, arguments=None):
    if name == "review_document":
        request = re.sub(r"\s+", "", context.get("user_request", ""))
        named = [target for target in (context.get("investigation") or {}).get("review_targets", [])
                 if target.get("sheet_name") and re.sub(r"\s+", "", target["sheet_name"]) in request]
        columns = [column for column in (context.get("workspace") or {}).get("columns", [])
                   if column.get("header") and re.sub(r"\s+", "", column["header"]) in request]
        references = (context.get("investigation") or {}).get("review_targets", [])
        explicit_pdf = named or requested_review_kind(context) is not None or re.search(r"pdf|검토|추출", request, re.I) or any(
            target.get("filename") and re.sub(r"\s+", "", target["filename"]) in request for target in references)
        if ((arguments or {}).get("action") == "preprocess" and columns and not explicit_pdf
                and not context.get("agent_execution")):
            targets = ", ".join(f"{column['header']} (column_id={column['column_id']})" for column in columns)
            raise ReviewTargetError(
                f"사용자가 명시한 대상은 작업표의 {targets}입니다. PDF 검토 시트를 요청하지 않았습니다. "
                "요청한 규칙을 유지하고 preprocess 또는 remove_words의 실제 작업표 column_id로 다시 호출하세요.",
                answer="요청한 작업표 열에 맞는 정제 작업을 구성하지 못했어요. 작업표와 PDF 검토 시트 모두 수정하지 않았습니다.")
        if len(named) == 1 and str((arguments or {}).get("document_id")) != named[0]["document_id"]:
            raise ReviewTargetError("사용자가 명시한 검토 시트와 문서가 다릅니다. review_targets의 sheet_name과 document_id를 다시 확인하세요.")
        return
    if name not in {"preprocess", "remove_words", "start_task"}:
        return
    if name == "start_task" and (arguments or {}).get("task_type") == "formula":
        return
    kind = requested_review_kind(context)
    if kind is None:
        return
    targets = [item for item in (context.get("investigation") or {}).get("review_targets", [])
               if item["kind"] == kind]
    if not targets:
        raise ReviewTargetError("요청한 PDF 검토 시트에 연결된 추출 자료를 찾지 못했어요. 첨부 문서 상태를 확인해 주세요. 작업표로 대신 실행하지 않습니다.")
    raise ReviewTargetError("요청 대상은 PDF 검토 시트입니다. investigation.review_targets의 문서·종류·열을 확인해 "
                           "review_document(action='preprocess')로 요청한 규칙을 모두 전달하세요. "
                           "문서가 여러 개라 대상을 정할 수 없으면 문서 이름을 확인하세요. 작업표의 범위 선택은 필요하지 않습니다.")


class ReviewTargetError(ValueError):
    def __init__(self, message, *, answer="PDF 검토 시트 대상 연결을 확인하지 못했어요. 첨부 문서 이름을 알려주세요. 작업표에는 실행하지 않았습니다."):
        super().__init__(message)
        self.answer = answer
