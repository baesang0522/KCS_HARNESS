from typing import Literal
from uuid import UUID
from fastapi import APIRouter, Query, Request
from services import write_recovery as service

router = APIRouter(prefix="/write-recovery", tags=["write-recovery"])
Kind = Literal["operation", "formula"]


@router.get("")
async def pending(conversation_id: UUID, request: Request, worksheet_id: str | None = None, table_id: str | None = None, job_id: list[UUID] = Query(default=[])):
    async with request.app.state.conversations.edit(str(conversation_id)):
        return [service.public(job, kind)
                for kind, jobs in (("operation", request.app.state.operation_jobs), ("formula", request.app.state.formula_jobs))
                for job in jobs.values() if (job.source.conversation_id == conversation_id or worksheet_id is not None
                and job.source.worksheet_id == worksheet_id and job.source.table_id == table_id)
                and (job.status in {"APPLYING", "UNKNOWN"} or getattr(job.source, kind + "_job_id") in job_id and job.status in {"APPLIED", "NOT_APPLIED"})]


@router.put("/{kind}/{job_id}/evidence")
async def evidence(kind: Kind, job_id: UUID, conversation_id: UUID, payload: service.WriteEvidence, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)):
        job = service.find(request.app.state, kind, job_id, conversation_id)
        service.save_evidence(job, kind, payload)
        return service.public(job, kind)


@router.post("/{kind}/{job_id}/check")
async def check(kind: Kind, job_id: UUID, conversation_id: UUID, payload: service.WriteObservation, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)):
        job = service.find(request.app.state, kind, job_id, conversation_id)
        return service.recover(job, kind, payload)
