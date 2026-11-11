"""사용자에게 전달할 서버 오류 문구와 HTTP 응답 형식을 한곳에서 정리한다."""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from repositories.conversation_repository import ConversationNotFound
from services.errors import DocumentError, ConflictError, ModelProcessingError, NotFoundError


def validation_message(error: ValueError | RequestValidationError) -> str:
    if not isinstance(error, (ValidationError, RequestValidationError)):
        return str(error)
    messages = []
    for item in error.errors():
        kind = item["type"]
        if kind == "value_error":
            message = item["msg"].removeprefix("Value error, ")
        elif kind == "missing":
            message = "필수 입력값을 확인하세요."
        elif kind == "json_invalid":
            message = "요청 내용을 읽지 못했습니다. 다시 시도하세요."
        else:
            message = "입력값의 형식과 허용 범위를 확인하세요."
        if message not in messages:
            messages.append(message)
    return "\n".join(messages) or "입력값을 확인하세요."


async def request_validation_response(request: Request, error: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": validation_message(error)})


async def service_error_response(request: Request, error: Exception):
    if isinstance(error, ConversationNotFound):
        return JSONResponse(status_code=404, content={"detail": "대화가 없습니다. 새 대화를 시작하세요."})
    status = {DocumentError: 422, NotFoundError: 404, ConflictError: 409, ModelProcessingError: 502}.get(type(error), 500)
    return JSONResponse(status_code=status, content={"detail": str(error)})
