from uuid import UUID

from fastapi import APIRouter, Request

from services.errors import ConflictError
from services.jobs.counterparty_cleanup import service as counterparty_service
from services.jobs.counterparty_cleanup.schemas import (
    CounterpartyPreview,
    CreateJobRequest as CounterpartyCreateJobRequest,
    Job as CounterpartyJob,
    PreviewRequest as CounterpartyPreviewRequest,
)
from services.jobs.model_normalization import service as model_service
from services.jobs.model_normalization.schemas import (
    CreateJobRequest as ModelCreateJobRequest,
    NormalizationPreview, RuleSet,
)
from services.jobs.formula import service as formula_service
from services.jobs.formula.schemas import (
    CreateJobRequest as FormulaCreateJobRequest,
    FormulaApprovalRequest,
    FormulaPreview,
    Job as FormulaJob,
)

router = APIRouter(prefix="/jobs")


@router.post("")
async def create_job(
    payload: (
        FormulaCreateJobRequest
        | ModelCreateJobRequest
        | CounterpartyCreateJobRequest
    ),
    request: Request,
):
    if isinstance(payload, FormulaCreateJobRequest):
        service = formula_service
    elif isinstance(payload, CounterpartyCreateJobRequest):
        service = counterparty_service
    else:
        service = model_service
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
    if isinstance(job, FormulaJob):
        return formula_service.public_job(formula_service.find_job(jobs, job_id))
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
    if isinstance(jobs.get(str(job_id)), FormulaJob):
        return await formula_service.plan_job(
            job_id, jobs, request.app.state.runtime,
        )
    if isinstance(jobs.get(str(job_id)), CounterpartyJob):
        return await counterparty_service.review_candidates(
            job_id, conversation_id, jobs, request.app.state.runtime,
        )
    return await model_service.analyze_job(job_id, jobs, request.app.state.runtime)


@router.post(
    "/{job_id}/preview",
    response_model=NormalizationPreview | CounterpartyPreview,
)
async def preview_job(
    job_id: UUID,
    payload: RuleSet | CounterpartyPreviewRequest,
    request: Request,
):
    jobs = request.app.state.jobs
    if isinstance(jobs.get(str(job_id)), CounterpartyJob):
        if not isinstance(payload, CounterpartyPreviewRequest):
            raise ConflictError("해외거래처 승인 내용을 다시 확인하세요.")
        return await counterparty_service.preview_job(job_id, payload, jobs)
    if not isinstance(payload, RuleSet):
        raise ConflictError("모델규격 정제 규칙을 다시 확인하세요.")
    return await model_service.preview_job(
        job_id, payload, jobs,
    )


@router.post(
    "/{job_id}/previews/{preview_id}/approve",
    response_model=FormulaPreview | NormalizationPreview | CounterpartyPreview,
)
async def approve_preview(
    job_id: UUID,
    preview_id: UUID,
    request: Request,
    payload: FormulaApprovalRequest | None = None,
):
    jobs = request.app.state.jobs
    if isinstance(jobs.get(str(job_id)), FormulaJob):
        return formula_service.approve_preview(
            job_id, preview_id, payload, jobs,
        )
    if isinstance(jobs.get(str(job_id)), CounterpartyJob):
        return counterparty_service.approve_preview(job_id, preview_id, jobs)
    return model_service.approve_preview(
        job_id, preview_id, jobs,
    )


@router.post("/{job_id}/previews/{preview_id}/complete")
async def complete_preview(
    job_id: UUID,
    preview_id: UUID,
    request: Request,
):
    return formula_service.complete_job(
        job_id, preview_id, request.app.state.jobs,
    )
