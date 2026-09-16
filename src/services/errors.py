"""업무 오류. HTTP 상태 코드 변환은 API에서 담당한다."""


class ServiceError(Exception):
    pass


class NotFoundError(ServiceError):
    pass


class ConflictError(ServiceError):
    pass


class ModelProcessingError(ServiceError):
    pass
