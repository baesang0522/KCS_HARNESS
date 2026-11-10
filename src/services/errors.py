"""업무 오류. HTTP 상태 코드 변환은 API에서 담당한다."""


MODEL_RESPONSE_ERROR = "작업을 이해하지 못했습니다. 다시 한번 자세히 알려주세요."


class ServiceError(Exception):
    pass


class NotFoundError(ServiceError):
    pass


class ConflictError(ServiceError):
    pass


class ModelProcessingError(ServiceError):
    pass
