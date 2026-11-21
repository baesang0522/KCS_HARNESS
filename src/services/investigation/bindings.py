"""확인한 PDF 조건과 실제 행 조건의 연결. 조건 내용이 달라지면 이전 연결은 재검토한다."""
import hashlib
import json


def condition_version(condition):
    data = condition.model_dump(mode="json") if hasattr(condition, "model_dump") else condition
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def bind_scope(request, investigation):
    request.condition_versions = {}
    if not request.condition_ids:
        return
    if not investigation or investigation.get("scope") != "bound":
        raise ValueError("PDF 조건과 같은 작업표를 연결한 뒤 선별하세요.")
    if request.mode not in {"intersect", "replace"}:
        raise ValueError("PDF 조건 적용은 현재 후보 좁히기 또는 명시적인 새 범위 지정으로 요청하세요.")
    if not request.note.strip():
        raise ValueError("조건의 대상 열·비교 기준과 사용자 확인 내용을 남기세요.")
    if len(set(request.condition_ids)) != len(request.condition_ids):
        raise ValueError("연결한 PDF 조건이 중복되었습니다.")
    known = {str(item["condition_id"]): item for item in investigation.get("conditions", [])}
    for key in request.condition_ids:
        item = known.get(key)
        if not item or item.get("status") != "confirmed":
            raise ValueError("확인된 최신 PDF 조건을 지정하세요. 수정 내용 반영 또는 재확인이 필요합니다.")
        request.condition_versions[key] = condition_version(item)
