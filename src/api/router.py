from fastapi import APIRouter

from api.api import chat, health
from api.schemas import ChatResponse

router = APIRouter()

router.add_api_route(
    path="/health",
    endpoint=health,
    methods=["GET"],
)

router.add_api_route(
    path="/chat",
    endpoint=chat,
    methods=["POST"],
    response_model=ChatResponse,
)