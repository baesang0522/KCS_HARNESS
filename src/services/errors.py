"""업무 오류. HTTP 상태 코드 변환은 API에서 담당한다."""

from pathlib import Path
import json


# Excel에서 재확인해야 하는 오류도 문구 자체는 서버에서 한 번만 관리한다.
SHARED_MESSAGES = json.loads(Path(__file__).with_name("error_messages.json").read_text(encoding="utf-8"))


MODEL_RESPONSE_ERROR = "작업을 이해하지 못했습니다. 다시 한번 자세히 알려주세요."


class ServiceError(Exception):
    pass


class NotFoundError(ServiceError):
    pass


class ConflictError(ServiceError):
    pass


class ModelProcessingError(ServiceError):
    pass
