from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from api.chat import router as chat_router
from api.jobs import router as jobs_router
from repositories.conversation_repository import ConversationNotFound
from services.errors import ConflictError, ModelProcessingError, NotFoundError

router = APIRouter()
router.include_router(chat_router)
router.include_router(jobs_router)


async def service_error_response(request: Request, error: Exception):
    if isinstance(error, ConversationNotFound):
        return JSONResponse(
            status_code=404,
            content={"detail": "대화가 없습니다. 새 대화를 시작하세요."},
        )
    status = {
        NotFoundError: 404,
        ConflictError: 409,
        ModelProcessingError: 502,
    }.get(type(error), 500)
    return JSONResponse(status_code=status, content={"detail": str(error)})
