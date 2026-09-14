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
    app.state.runtime = create_runtime()
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
