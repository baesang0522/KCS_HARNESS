"""Console diagnostics shared by chat and tool execution."""
import json
import time


_SECRET_KEYS = {"authorization", "cookie", "setcookie", "password", "passwd",
                "apikey", "token", "accesstoken", "refreshtoken", "secret", "clientsecret"}


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if str(key).lower().replace("_", "").replace("-", "") in _SECRET_KEYS
                else redact(item) for key, item in value.items()}
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
