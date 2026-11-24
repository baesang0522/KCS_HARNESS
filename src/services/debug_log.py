"""Console diagnostics shared by chat and tool execution."""
import json
import time
from asyncio import CancelledError
from contextlib import contextmanager


_SECRET_KEYS = {"authorization", "cookie", "setcookie", "password", "passwd",
                "apikey", "token", "accesstoken", "refreshtoken", "secret", "clientsecret"}
_DATA_COLLECTION_KEYS = {"rows", "groups", "sample_rows"}


def redact(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if str(key).lower().replace("_", "").replace("-", "") in _SECRET_KEYS:
                result[key] = "[REDACTED]"
            elif isinstance(item, (list, tuple)) and (
                key in _DATA_COLLECTION_KEYS or key == "row_ids" or str(key).endswith("_row_ids")
            ):
                # 로그용 사본만 요약한다. 원본·모델 입력·API 응답은 유지하며
                # 대규모 셀 배열을 순회하거나 JSON으로 직렬화하지 않는다.
                result[key] = {"count": len(item), "omitted": True}
            else:
                result[key] = redact(item)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value


def log_event(event: str, *, level="INFO", **fields) -> None:
    # 로그 출력 실패로 실제 작업이 실패하거나 재실행되지 않게 한다.
    try:
        print(json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level, "event": event, **redact(fields),
        }, ensure_ascii=False, default=str), flush=True)
    except (OSError, ValueError, TypeError, RecursionError):
        pass


@contextmanager
def job_event(event, source, kind, **details):
    """기존 작업 요청만 관측한다. 셀 값·수식·복구 증거 원문은 전달하지 않는다."""
    ids = {
        "conversation_id": str(source.conversation_id),
        "origin_request_id": str(source.origin_request_id) if source.origin_request_id else None,
        "job_id": str(getattr(source, kind + "_job_id")),
        "job_kind": kind,
        "workspace_id": str(source.workspace_id) if source.workspace_id else None,
    }
    started = time.perf_counter()
    log_event(event + ".started", **ids, **details)
    try:
        yield details
    except (Exception, CancelledError) as error:
        log_event(event + ".failed", level="WARNING" if isinstance(error, CancelledError) else "ERROR",
                  **ids, **details, error_type=type(error).__name__, error_message=str(error),
                  elapsed_ms=round((time.perf_counter() - started) * 1000))
        raise
    else:
        failed = details.get("status") == "FAILED"
        log_event(event + (".failed" if failed else ".completed"),
                  level="ERROR" if failed else "WARNING" if details.get("status") == "UNKNOWN" else "INFO",
                  **ids, **details, elapsed_ms=round((time.perf_counter() - started) * 1000))
