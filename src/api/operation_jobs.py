"""정제 실행 기록 API. 셀 데이터는 미리보기 요청 중에만 사용한다."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from services.operations import jobs as service
from services.operations.jobs import (
    CreateOperationJob,
    JobPreview,
    JobUpdate,
    OperationJob,
    OutputPlacement,
)
from services.operations.schemas import OperationResponse

router = APIRouter(prefix="/operation-jobs", tags=["Operations"])


@router.post("", response_model=OperationJob)
async def create_job(payload: CreateOperationJob, request: Request):
    async with request.app.state.conversations.edit(
        str(payload.conversation_id)
    ):
        return service.create_job(payload, request.app.state.operation_jobs)


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
    async with request.app.state.conversations.edit(str(conversation_id)):
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)

        try:
            return service.preview_job(job, payload)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/{job_id}/apply", response_model=OperationJob)
async def begin_apply(job_id: UUID, conversation_id: UUID, payload: OutputPlacement, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)):
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)
        return service.begin_apply(job, payload)


@router.post("/{job_id}/status", response_model=OperationJob)
async def update_job(job_id: UUID, conversation_id:UUID, payload: JobUpdate, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)):
        job = service.find_job(request.app.state.operation_jobs, job_id, conversation_id)
        return service.update_job(job, payload)



