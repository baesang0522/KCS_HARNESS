"""수식 작업 API. 공통 문자열 연산은 operations 라우터에서 처리한다."""
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from api.errors import validation_message

from services.debug_log import job_event
from services.formula import service
from services.formula.schemas import CreateFormulaJobRequest, FormulaApprovalRequest, FormulaPreview, FormulaCompletion, FormulaUnknownRequest

router = APIRouter(prefix="/formula-jobs", tags=["formula"])


@router.post("")
async def create_formula_job(payload: CreateFormulaJobRequest, request: Request):
    with job_event("formula.create", payload, "formula", row_count=payload.row_count,
                   replayed=str(payload.formula_job_id) in request.app.state.formula_jobs) as event:
        async with request.app.state.conversations.request(str(payload.conversation_id), str(payload.formula_job_id)):
            result = await service.create_formula_job(payload, request.app.state.conversations, request.app.state.formula_jobs)
            event["status"] = result["status"]
            return result


@router.get("/{formula_job_id}")
async def read_formula_job(formula_job_id: UUID, request: Request):
    return service.public_formula_job(service.find_formula_job(request.app.state.formula_jobs, formula_job_id))


@router.post("/{formula_job_id}/analyze")
async def analyze_formula_job(formula_job_id: UUID, request: Request):
    job = service.find_formula_job(request.app.state.formula_jobs, formula_job_id)
    with job_event("formula.preview", job.source, "formula") as event:
        async with request.app.state.conversations.request(str(job.source.conversation_id), str(formula_job_id)):
            result = await service.plan_formula_job(formula_job_id, request.app.state.formula_jobs, request.app.state.runtime)
            event.update(status=job.status, preview_id=str(job.preview.preview_id) if job.preview else None)
            return result


@router.post("/{formula_job_id}/previews/{preview_id}/approve", response_model=FormulaPreview)
async def approve_preview(formula_job_id: UUID, preview_id: UUID, request: Request,
                          payload: FormulaApprovalRequest | None = None):
    from services.write_recovery import ensure_resolved
    job = service.find_formula_job(request.app.state.formula_jobs, formula_job_id)
    with job_event("formula.apply_start", job.source, "formula", preview_id=str(preview_id), previous_status=job.status) as event:
        try:
            async with request.app.state.conversations.edit(str(job.source.conversation_id)):
                ensure_resolved(request.app.state, job.source, str(formula_job_id))
                result = service.approve_preview(formula_job_id, preview_id, payload, request.app.state.formula_jobs)
                event["status"] = job.status
                return result
        except ValueError as error:
            raise HTTPException(status_code=422, detail=validation_message(error)) from error


@router.post("/{formula_job_id}/previews/{preview_id}/complete")
async def complete_preview(formula_job_id: UUID, preview_id: UUID, payload: FormulaCompletion, request: Request):
    job = service.find_formula_job(request.app.state.formula_jobs, formula_job_id)
    with job_event("formula.status", job.source, "formula", preview_id=str(preview_id), previous_status=job.status,
                   reported_status="APPLIED", replayed=job.status == "APPLIED") as event:
        result = service.complete_formula_job(formula_job_id, preview_id, payload, request.app.state.formula_jobs)
        event.update(status=job.status, result_column_ids=payload.result_column_ids)
        return result


@router.post("/{formula_job_id}/previews/{preview_id}/unknown")
async def unknown_preview(formula_job_id: UUID, preview_id: UUID, request: Request,
                          payload: FormulaUnknownRequest | None = None):
    job = service.find_formula_job(request.app.state.formula_jobs, formula_job_id)
    with job_event("formula.status", job.source, "formula", preview_id=str(preview_id), previous_status=job.status,
                   reported_status="UNKNOWN", replayed=job.status == "UNKNOWN",
                   client_error=payload.error_message if payload else None) as event:
        result = service.mark_formula_unknown(formula_job_id, preview_id, request.app.state.formula_jobs)
        event["status"] = job.status
        return result
