from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.router import router, service_error_response
from repositories.conversation_repository import ConversationNotFound, MemoryConversationRepository
from services.errors import ServiceError
from runtime import create_runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.runtime = create_runtime()
    # PoC 상태는 이 API 프로세스의 수명 동안만 유지한다.
    app.state.conversations = MemoryConversationRepository()
    app.state.jobs = {}

    yield

app = FastAPI(
    title="KCS Harness",
    version="0.0.1",
    lifespan=lifespan,
)

app.include_router(router)
app.mount(
    "/static",
    StaticFiles(directory=Path(__file__).resolve().parent / "static"),
    name="static",
)

app.add_exception_handler(ServiceError, service_error_response)
app.add_exception_handler(ConversationNotFound, service_error_response)
