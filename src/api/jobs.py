from uuid import UUID

from fastapi import APIRouter, Request

from services.jobs.counterparty_cleanup import service as counterparty_service
from services.jobs.counterparty_cleanup.schemas import (
    CreateJobRequest as CounterpartyCreateJobRequest,
    Job as CounterpartyJob,
)
from services.jobs.model_normalization import service as model_service
from services.jobs.model_normalization.schemas import (
    CreateJobRequest as ModelCreateJobRequest,
    NormalizationPreview, RuleSet,
)

router = APIRouter(prefix="/jobs")


@router.post("")
async def create_job(
    payload: ModelCreateJobRequest | CounterpartyCreateJobRequest,
    request: Request,
):
    service = (
        counterparty_service
        if isinstance(payload, CounterpartyCreateJobRequest)
        else model_service
    )
    return await service.create_job(
        payload, request.app.state.conversations,
        request.app.state.jobs,
    )


@router.get("/{job_id}")
async def read_job(
    job_id: UUID, request: Request, conversation_id: UUID | None = None,
):
    jobs = request.app.state.jobs
    job = jobs.get(str(job_id))
    if isinstance(job, CounterpartyJob):
        return counterparty_service.public_job(counterparty_service.find_job(
            jobs, job_id, conversation_id,
        ))
    return model_service.public_job(model_service.find_job(
        jobs, job_id,
    ))


@router.post("/{job_id}/analyze")
async def analyze_job(
    job_id: UUID, request: Request, conversation_id: UUID | None = None,
):
    jobs = request.app.state.jobs
    if isinstance(jobs.get(str(job_id)), CounterpartyJob):
        return await counterparty_service.review_candidates(
            job_id, conversation_id, jobs, request.app.state.runtime,
        )
    return await model_service.analyze_job(job_id, jobs, request.app.state.runtime)


@router.post("/{job_id}/preview", response_model=NormalizationPreview)
async def preview_job(job_id: UUID, payload: RuleSet, request: Request):
    return await model_service.preview_job(
        job_id, payload, request.app.state.jobs,
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
