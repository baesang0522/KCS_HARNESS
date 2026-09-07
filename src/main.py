from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from agents.agent import AgentNode
from graphs.harness_graph import build_harness_graph
from llm import create_model
from settings import load_settings, load_system_prompt
from tools.registry import get_local_tools


class AgentRequest(BaseModel):
    message: str


class AgentResponse(BaseModel):
    request_id: str
    answer: str


app = FastAPI(
    title="KCS Harness",
    version="0.0.1"
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/agent/invoke", response_model=AgentResponse)
async def invoke_agent(payload: AgentRequest) -> AgentResponse:
    return AgentResponse(request_id=str(uuid4()), answer=f"요청을 정상적으로 받았습니다: {payload.message}")



