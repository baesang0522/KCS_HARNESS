from contextlib import asynccontextmanager

from fastapi import FastAPI

from api.router import router
from runtime import create_runtime


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.runtime = create_runtime()
    yield

app = FastAPI(
    title="KCS Harness",
    version="0.0.1",
    lifespan=lifespan,
)
app.include_router(router)
