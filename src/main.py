from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.router import router
from runtime import create_runtime
from repositories.memory_conversation_repository import (
    MemoryConversationRepository,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime = create_runtime()

    if runtime.settings.storage.provider != "memory":
        raise RuntimeError(
            "PostgreSQL 저장소는 아직 구현되지 않았습니다. "
            "현재 실행 테스트는 KCS_ENV=external로 진행하세요."
        )

    app.state.runtime = runtime
    app.state.conversations = MemoryConversationRepository()
    yield

app = FastAPI(
    title="KCS Harness",
    version="0.0.1",
    lifespan=lifespan,
)

app.mount(
    "/static",
    StaticFiles(directory=Path(__file__).resolve().parent / "static"),
    name="static",
)
app.include_router(router)
