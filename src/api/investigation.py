from uuid import UUID
from time import perf_counter

from fastapi import APIRouter, Request

from services.documents.schemas import DocumentWorkspace
from services.investigation.schemas import ExtractConditions, SaveInvestigation, SaveReview
from services.investigation.service import bind_investigation, public_investigation, save_investigation, save_review
from services.investigation.extraction import extract_conditions
from services.debug_log import log_event

router = APIRouter(prefix="/conversations/{conversation_id}/investigation", tags=["investigation"])


@router.get("")
async def read_investigation(conversation_id: UUID, request: Request):
    state = request.app.state.conversations.investigation_snapshot(str(conversation_id))
    return public_investigation(state)


@router.put("")
async def update_investigation(conversation_id: UUID, payload: SaveInvestigation, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(save_investigation(conversation, payload))


@router.post("/extractions/{request_id}")
async def read_conditions(conversation_id: UUID, request_id: UUID, payload: ExtractConditions, request: Request):
    repository = request.app.state.conversations
    cid, rid = str(conversation_id), str(request_id)
    ids = dict(conversation_id=cid, request_id=rid, document_id=str(payload.document_id))
    started = perf_counter()
    log_event("pdf.extraction.received", **ids)
    try:
        async with repository.request(cid, rid):
            async with repository.edit(cid) as conversation:
                result = public_investigation(await extract_conditions(conversation, payload, request.app.state.runtime, rid))
    except Exception as error:
        cause = error.__cause__ or error
        log_event("pdf.extraction.failed", level="ERROR", **ids,
                  error_type=type(error).__name__, error_message=str(error),
                  cause_type=type(cause).__name__, cause_message=str(cause),
                  elapsed_ms=round((perf_counter() - started) * 1000))
        raise
    log_event("pdf.extraction.completed", **ids, elapsed_ms=round((perf_counter() - started) * 1000))
    return result


@router.put("/workspace")
async def bind_workspace(conversation_id: UUID, payload: DocumentWorkspace, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(bind_investigation(conversation, payload))


@router.put("/reviews/{document_id}")
async def update_review(conversation_id: UUID, document_id: UUID, payload: SaveReview, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return public_investigation(save_review(conversation, str(document_id), payload))
