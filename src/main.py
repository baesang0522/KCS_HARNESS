from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.router import router, service_error_response
from repositories.conversation_repository import ConversationNotFound
from services.errors import ServiceError
from runtime import create_runtime
from repositories.memory_conversation_repository import (
    MemoryConversationRepository,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime = create_runtime()

    if runtime.settings.storage.provider == "memory":
        repository = MemoryConversationRepository()

    else:
        from utils.database import PostgresDatabase
        from repositories.postgres_conversation_repository import (
            PostgresConversationRepository,
        )

        database = PostgresDatabase(runtime.settings.storage)

        repository = PostgresConversationRepository(
            connection_factory=database.connection,
        )

        await repository.initialize()

    app.state.runtime = runtime
    app.state.conversations = repository
    app.state.jobs = {}

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

app.add_exception_handler(ServiceError, service_error_response)
app.add_exception_handler(ConversationNotFound, service_error_response)
