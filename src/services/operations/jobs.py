from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from services.errors import ConflictError, NotFoundError
from services.operations.schemas import (
    ColumnId,
    Operation,
    OperationRequest,
    Row,
    StrictModel,
    TaskType,
)
from services.operations.service import execute

JobStatus = Literal[
    "CREATED",
    "PREVIEW_READY",
    "APPLYING",
    "APPLIED",
    "NO_CHANGE",
    "CANCELLED",
    "FAILED",
    "UNKNOWN",
]


class CreateOperationJob(StrictModel):
    operation_job_id: UUID
    conversation_id: UUID
    workspace_id: UUID
    worksheet_id: ColumnId
    table_id: ColumnId
    task_type: TaskType
    row_start: int = Field(ge=0, lt=1048576)
    row_count: int = Field(ge=1, lt=400000)
    operation: Operation

    @model_validator(mode="after")
    def validate_scope(self):
        if self.row_start + self.row_count > 1048576:
            raise ValueError("처리 범위가 Excel 행 경계를 벗어납니다.")
        if len(self.model_dump_json().encode("utf-8")) > 262144:
            # 작업의 설정 용량. 현재는 메모리에 저장하기 때문에 너무 커지면 금방참 ㅇㅇ
            raise ValueError(
                "실행 설정은 최대 256KiB 입니다. 매핑을 나누어 실행하세요. "
            )
        return self


class OutputPlacement(StrictModel):
    anchor: ColumnId
    side: Literal["before", "after"]
    name: str = Field(min_length=1, max_length=200)


class JobUpdate(StrictModel):
    status: Literal[
        "PREVIEW_READY",
        "APPLIED",
        "NO_CHANGE",
        "CANCELLED",
        "FAILED",
        "UNKNOWN",
    ]
    result_column_ids: list[ColumnId] = Field(default_factory=list, max_length=100,)

    @model_validator(mode="after")
    def validate_result(self):
        if (self.status == "APPLIED") != bool(self.result_column_ids):
            raise ValueError("적용 완료일 때만 결과 열 ID가 필요합니다.")
        if len(set(self.result_column_ids)) != len(self.result_column_ids):
            raise ValueError("결과 열 ID가 중복되었습니다.")
        return self


class JobPreview(StrictModel):
    rows: list[Row] = Field(min_length=1, max_length=400000)


class OperationJob(StrictModel):
    source: CreateOperationJob
    status: JobStatus = "CREATED"
    output: OutputPlacement | None = None
    result_column_ids: list[ColumnId] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


def find_job(jobs: dict, job_id:UUID, conversation_id: UUID) -> OperationJob:
    job = jobs.get(str(job_id))

    if job is None or job.source.conversation_id != conversation_id:
        raise NotFoundError(
            "정제 실행 기록이 없습니다. "
            "현재는 서버 재시작 후에 새로 작업을 시작하셔야 합니다."
        )
    return job


def create_job(source: CreateOperationJob, jobs: dict) -> OperationJob:
    key = str(source.operation_job_id)
    if key in jobs:
        if jobs[key].source != source:
            raise ConflictError("같은 실행 ID에 다른 설정이 전달됐습니다.")
        return jobs[key]

    if len(jobs) >= 100:
        raise ConflictError("서버의 정제 실행 기록 100개 제한에 도달했습니다.")

    jobs[key] = OperationJob(source=source.model_copy(deep=True))
    return jobs[key]


def preview_job(job: OperationJob, payload: JobPreview):
    if job.status != "CREATED":
        raise ConflictError(
            "현재 상태에서는 미리보기를 계산할 수 없습니다."
        )
    request = OperationRequest(operation=job.source.operation, rows=payload.rows)
    start = job.source.row_start + 1
    stop = job.source.row_start + job.source.row_count

    if any(
        row.excel_row < start or row.excel_row > stop
        for row in request.rows
    ):
        raise ValueError("등록된 실행 범위 밖의 행입니다.")

    if (
        request.operation.kind == "group"
        and len(request.rows) != job.source.row_count
    ):
        raise ValueError("그룹 작업은 등록한 범위 전체를 한번에 전달하세요.")
    return execute(request)


def begin_apply(job: OperationJob, output: OutputPlacement) -> OperationJob:
    if job.status != "PREVIEW_READY":
        raise ConflictError(
            "새 미리보기만 적용할 수 있습니다. "
            "이미 시작한 실행은 다시 쓰지 않습니다."
        )
    job.output = output.model_copy(deep=True)
    job.status = "APPLYING"
    return job


def update_job(job: OperationJob, update: JobUpdate) -> OperationJob:
    if job.status == update.status:
        if job.result_column_ids != update.result_column_ids:
            raise ConflictError("이미 기록된 결과 열과 다릅니다.")
        return job

    allowed = {
        "CREATED": {
            "PREVIEW_READY",
            "NO_CHANGE",
            "CANCELLED",
            "FAILED",
        },
        "PREVIEW_READY": {
            "CANCELLED",
            "FAILED",
        },
        "APPLYING": {
            "APPLIED",
            "UNKNOWN",
        },
    }

    if update.status not in allowed.get(job.status, set()):
        raise ConflictError("허용되지 않는 실행 상태 변경입니다.")

    if set(update.result_column_ids) & set(job.source.operation.input_column_ids):
        raise ConflictError("결과는 입력과 다른 새 열이어야 합니다.")

    job.status = update.status
    job.result_column_ids = list(update.result_column_ids)
    return job


def operation_history_context(
    jobs: dict, *, conversation_id: str, workspace: dict | None
) -> dict:
    if not workspace:
        return {"records": [], "omitted_count": 0}

    columns = {
        str(column["column_id"]): column
        for column in workspace["columns"]
    }
    matched = [
        job for job in jobs.values()
        if str(job.source.conversation_id) == conversation_id
        and str(job.source.workspace_id) == str(workspace["workspace_id"])
        and job.source.worksheet_id == workspace["worksheet_id"]
        and str(job.source.table_id) == str(workspace["table_id"])
        and job.source.task_type == workspace["task_type"]
    ]
    matched.sort(key=lambda job: job.created_at, reverse=True)

    def column_info(column_id: str) -> dict:
        column = columns.get(str(column_id))
        return {
            "column_id": str(column_id),
            "current_header": column["header"] if column else None,
            "exists": column is not None,
        }

    records = []
    # shortcut: 현재 작업공간의 최근 8건만 제공한다. 오래된 실행·다른 시트 탐색은 별도 검색 단계에서 확장한다.
    for job in matched[:8]:
        operation = job.source.operation
        settings = operation.model_dump_json(exclude_defaults=True)
        results = []

        for index, column_id in enumerate(job.result_column_ids):
            result = column_info(column_id)
            result["purpose"] = (
                "change_status"
                if operation.kind == "group" and index == 1
                else "data"
            )
            result["can_continue"] = (
                job.status == "APPLIED" and result["exists"]
            )
            results.append(result)

        records.append({
            "job_id": str(job.source.operation_job_id),
            "created_at": job.created_at.isoformat(),
            "status": job.status,
            "kind": operation.kind,
            "input_columns": [
                column_info(column_id)
                for column_id in operation.input_column_ids
            ],
            "settings_excerpt": settings[:1600],
            "settings_truncated": len(settings) > 1600,
            "output_name": job.output.name if job.output else None,
            "result_columns": results,
            "executed_range": {
                "first_excel_row": job.source.row_start + 1,
                "row_count": job.source.row_count,
            },
        })

    return {
        "records": records,
        "omitted_count": max(0, len(matched) - len(records)),
    }