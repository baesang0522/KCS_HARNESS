"""정제 실행 기록 API. 셀 데이터는 미리보기 요청 중에만 사용한다."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from api.errors import validation_message

from services.debug_log import job_event
from services.operations import jobs as service
from services.operations.jobs import (
    CreateOperationJob,
    JobPreview,
    JobUpdate,
    OperationJob,
    OutputPlacement,
)
from services.operations.schemas import OperationResponse
from services.supplier_matching import references, validate_references
from services import model_matching

router = APIRouter(prefix="/operation-jobs", tags=["Operations"])


@router.post("", response_model=OperationJob)
async def create_job(payload: CreateOperationJob, request: Request):
    with job_event("operation.create", payload, "operation", operation_kind=payload.operation.kind,
                   row_count=payload.row_count, replayed=str(payload.operation_job_id) in request.app.state.operation_jobs) as event:
        async with request.app.state.conversations.edit(str(payload.conversation_id)) as conversation:
            suppliers = references(conversation, payload) if payload.operation.kind == "match_suppliers" else None
            models = model_matching.references(conversation, payload) if payload.operation.extraction_mode == "pdf" else None
            job = service.create_job(payload, request.app.state.operation_jobs, suppliers, models)
            event["status"] = job.status
            return job


@router.get("", response_model=list[OperationJob])
async def list_jobs(conversation_id: UUID, workspace_id:UUID, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)):
        return [
            job
            for job in request.app.state.operation_jobs.values()
            if job.source.conversation_id == conversation_id
            and job.source.workspace_id == workspace_id
        ]


@router.post("/{job_id}/preview", response_model=OperationResponse)
async def preview_job(job_id: UUID, conversation_id: UUID, payload: JobPreview, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)
        with job_event("operation.preview", job.source, "operation", batch_row_count=len(payload.rows),
                       selected_count=payload.selected_count) as event:
            validate_references(job, conversation)
            model_matching.validate_references(job, conversation)
            try:
                result = service.preview_job(job, payload)
                event.update(status=job.status, result_row_count=len(result.rows), changed_count=result.changed_count)
                return result
            except ValueError as error:
                raise HTTPException(status_code=422, detail=validation_message(error)) from error


@router.post("/{job_id}/apply", response_model=OperationJob)
async def begin_apply(job_id: UUID, conversation_id: UUID, payload: OutputPlacement, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)
        with job_event("operation.apply_start", job.source, "operation", previous_status=job.status,
                       output_mode=payload.mode, output_column_id=payload.column_id) as event:
            validate_references(job, conversation)
            model_matching.validate_references(job, conversation)
            from services.write_recovery import ensure_resolved
            ensure_resolved(request.app.state, job.source, str(job_id))
            result = service.begin_apply(job, payload)
            event["status"] = job.status
            return result


@router.post("/{job_id}/status", response_model=OperationJob)
async def update_job(job_id: UUID, conversation_id:UUID, payload: JobUpdate, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)
        with job_event("operation.status", job.source, "operation", previous_status=job.status,
                       reported_status=payload.status, replayed=job.status == payload.status, client_error=payload.error_message) as event:
            result = service.update_job(job, payload)
            event.update(status=job.status, result_column_ids=job.result_column_ids)
            return result



