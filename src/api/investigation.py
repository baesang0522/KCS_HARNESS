from uuid import UUID

from fastapi import APIRouter, Request

from services.investigation import ExtractConditions, SaveInvestigation, extract_conditions, save_investigation

router = APIRouter(prefix="/conversations/{conversation_id}/investigation", tags=["investigation"])


@router.get("")
async def read_investigation(conversation_id: UUID, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return conversation.investigation


@router.put("")
async def update_investigation(conversation_id: UUID, payload: SaveInvestigation, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return save_investigation(conversation, payload)


@router.post("/extractions/{request_id}")
async def read_conditions(conversation_id: UUID, request_id: UUID, payload: ExtractConditions, request: Request):
    repository = request.app.state.conversations
    cid, rid = str(conversation_id), str(request_id)
    async with repository.request(cid, rid):
        async with repository.edit(cid) as conversation:
            return await extract_conditions(conversation, payload, request.app.state.runtime, rid)
