from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from api.schemas import ChatRequest, ChatResponse
from repositories.conversation_repository import to_messages
from services.chat import process_chat, workflow_snapshot

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/conversations")
async def create_conversation(request: Request):
    try:
        conversation_id = await request.app.state.conversations.create()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"conversation_id": conversation_id}


@router.get("/conversations/{conversation_id}")
async def read_conversation(conversation_id: UUID, request: Request):
    cid = str(conversation_id)
    async with request.app.state.conversations.edit(cid) as conversation:
        return {
            "conversation_id": cid,
            "messages": to_messages(conversation.turns),
            "workflow": workflow_snapshot(
                conversation.workflow, request.app.state.jobs,
            ),
        }


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    return await process_chat(
        runtime=request.app.state.runtime,
        repository=request.app.state.conversations,
        jobs=request.app.state.jobs,
        conversation_id=str(payload.conversation_id),
        request_id=str(payload.request_id),
        message=payload.message,
    )
