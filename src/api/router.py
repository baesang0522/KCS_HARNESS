from fastapi import APIRouter

from api.api import (
    chat,
    create_conversation,
    health,
    read_conversation,
)
from api.schemas import ChatResponse

router = APIRouter()

router.add_api_route(
    "/health",
    health,
    methods=["GET"],
)

router.add_api_route(
    "/conversations",
    create_conversation,
    methods=["POST"],
)

router.add_api_route(
    "/conversations/{conversation_id}",
    read_conversation,
    methods=["GET"],
)

router.add_api_route(
    "/chat",
    chat,
    methods=["POST"],
    response_model=ChatResponse,
)