"""수식 작업 API. 공통 문자열 연산은 operations 라우터에서 처리한다."""
from uuid import UUID

from fastapi import APIRouter, Request

from services.formula import service
from services.formula.schemas import CreateFormulaJobRequest, FormulaApprovalRequest, FormulaPreview

router = APIRouter(prefix="/formula-jobs", tags=["formula"])


@router.post("")
async def create_formula_job(payload: CreateFormulaJobRequest, request: Request):
    async with request.app.state.conversations.request(
        str(payload.conversation_id), str(payload.formula_job_id)
    ):
        return await service.create_formula_job(payload, request.app.state.conversations, request.app.state.formula_jobs)


@router.get("/{formula_job_id}")
async def read_formula_job(formula_job_id: UUID, request: Request):
    return service.public_formula_job(service.find_formula_job(request.app.state.formula_jobs, formula_job_id))


@router.post("/{formula_job_id}/analyze")
async def analyze_formula_job(formula_job_id: UUID, request: Request):
    job = service.find_formula_job(request.app.state.formula_jobs, formula_job_id)
    async with request.app.state.conversations.request(
        str(job.source.conversation_id), str(formula_job_id)
    ):
        return await service.plan_formula_job(formula_job_id, request.app.state.formula_jobs, request.app.state.runtime)


@router.post("/{formula_job_id}/previews/{preview_id}/approve", response_model=FormulaPreview)
async def approve_preview(formula_job_id: UUID, preview_id: UUID, request: Request,
                          payload: FormulaApprovalRequest | None = None):
    return service.approve_preview(formula_job_id, preview_id, payload, request.app.state.formula_jobs)


@router.post("/{formula_job_id}/previews/{preview_id}/complete")
async def complete_preview(formula_job_id: UUID, preview_id: UUID, request: Request):
    return service.complete_formula_job(formula_job_id, preview_id, request.app.state.formula_jobs)
