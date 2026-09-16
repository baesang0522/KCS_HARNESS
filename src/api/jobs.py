from uuid import UUID

from fastapi import APIRouter, Request

from services.jobs.model_normalization import service
from services.jobs.model_normalization.schemas import (
    CreateJobRequest, NormalizationPreview, RuleSet,
)

router = APIRouter(prefix="/jobs")


@router.post("")
async def create_job(payload: CreateJobRequest, request: Request):
    return await service.create_job(
        payload, request.app.state.conversations,
        request.app.state.normalization_jobs,
    )


@router.get("/{job_id}")
async def read_job(job_id: UUID, request: Request):
    return service.public_job(service.find_job(
        request.app.state.normalization_jobs, job_id,
    ))


@router.post("/{job_id}/analyze")
async def analyze_job(job_id: UUID, request: Request):
    return await service.analyze_job(
        job_id, request.app.state.normalization_jobs, request.app.state.runtime,
    )


@router.post("/{job_id}/preview", response_model=NormalizationPreview)
async def preview_job(job_id: UUID, payload: RuleSet, request: Request):
    return await service.preview_job(
        job_id, payload, request.app.state.normalization_jobs,
    )


@router.post("/{job_id}/previews/{preview_id}/approve", response_model=NormalizationPreview)
async def approve_preview(
    job_id: UUID,
    preview_id: UUID,
    request: Request,
):
    return service.approve_preview(
        job_id, preview_id, request.app.state.normalization_jobs,
    )
