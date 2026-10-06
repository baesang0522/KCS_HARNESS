"""수식 작업 API. 공통 문자열 연산은 operations 라우터에서 처리한다."""
from uuid import UUID

from fastapi import APIRouter, Request

from services.formula import service
from services.formula.schemas import CreateJobRequest, FormulaApprovalRequest, FormulaPreview

router = APIRouter(prefix="/jobs", tags=["formula"])


@router.post("")
async def create_job(payload: CreateJobRequest, request: Request):
    return await service.create_job(payload, request.app.state.conversations, request.app.state.jobs)


@router.get("/{job_id}")
async def read_job(job_id: UUID, request: Request):
    return service.public_job(service.find_job(request.app.state.jobs, job_id))


@router.post("/{job_id}/analyze")
async def analyze_job(job_id: UUID, request: Request):
    return await service.plan_job(job_id, request.app.state.jobs, request.app.state.runtime)


@router.post("/{job_id}/previews/{preview_id}/approve", response_model=FormulaPreview)
async def approve_preview(job_id: UUID, preview_id: UUID, request: Request,
                          payload: FormulaApprovalRequest | None = None):
    return service.approve_preview(job_id, preview_id, payload, request.app.state.jobs)


@router.post("/{job_id}/previews/{preview_id}/complete")
async def complete_preview(job_id: UUID, preview_id: UUID, request: Request):
    return service.complete_job(job_id, preview_id, request.app.state.jobs)
