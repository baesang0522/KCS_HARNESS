from uuid import UUID

from fastapi import APIRouter, Request

from services.documents.schemas import DocumentWorkspace
from services.investigation.schemas import ExtractConditions, SaveInvestigation, SaveReview
from services.investigation.service import bind_investigation, public_investigation, save_investigation, save_review
from services.investigation.extraction import extract_conditions

router = APIRouter(prefix="/conversations/{conversation_id}/investigation", tags=["investigation"])


@router.get("")
async def read_investigation(conversation_id: UUID, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(conversation.investigation)


@router.put("")
async def update_investigation(conversation_id: UUID, payload: SaveInvestigation, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(save_investigation(conversation, payload))


@router.post("/extractions/{request_id}")
async def read_conditions(conversation_id: UUID, request_id: UUID, payload: ExtractConditions, request: Request):
    repository = request.app.state.conversations
    cid, rid = str(conversation_id), str(request_id)
    async with repository.request(cid, rid):
        async with repository.edit(cid) as conversation:
            return public_investigation(await extract_conditions(conversation, payload, request.app.state.runtime, rid))


@router.put("/workspace")
async def bind_workspace(conversation_id: UUID, payload: DocumentWorkspace, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(bind_investigation(conversation, payload))


@router.put("/reviews/{document_id}")
async def update_review(conversation_id: UUID, document_id: UUID, payload: SaveReview, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(save_review(conversation, str(document_id), payload))
