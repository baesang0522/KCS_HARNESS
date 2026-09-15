import asyncio
import json
import logging
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, Field, model_validator


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/normalization/jobs")

CellText = Annotated[str, Field(max_length=1000)]
ColumnIndex = Annotated[int, Field(ge=0, le=2)]

class ColumnMapping(BaseModel):
    trade_name: ColumnIndex
    declared_name: ColumnIndex
    model_spec: ColumnIndex

    @model_validator(mode="after")
    def check_distinct(self):
        indexes = {
            self.trade_name,
            self.declared_name,
            self.model_spec,
        }
        if len(indexes) != 3:
            raise ValueError("세 역할에는 서로 다른 열을 지정하세요. ")
        return self


class SampleRow(BaseModel):
    cells: list[CellText] = Field(min_length=3, max_length=3)


class CreateJobRequest(BaseModel):
    job_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=256)
    sheet_name: str = Field(min_length=1, max_length=256)
    address: str = Field(min_length=1, max_length=512)
    row_start: int = Field(ge=0)
    column_start: int = Field(ge=0)
    row_count: int = Field(ge=0, le=400001)
    headers: list[CellText] = Field(min_length=3, max_length=3)
    mapping: ColumnMapping
    samples: list[SampleRow] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def check_samples(self):
        if len(self.samples) > self.row_count - 1:
            raise ValueError("표본 수가 선택 가능한 데이터 행 수보다 많습니다.")

        if not any(cell.strip() for row in self.samples for cell in row.cells):
            raise ValueError("표본 데이터가 모두 비어 있습니다.")

        return self


class Job(BaseModel):
    source: CreateJobRequest
    status: Literal["CREATED", "ANALYZING", "REVIEW_READY", "FAILED"] = "CREATED"
    analysis: str = ""
    error: str = ""


def find_job(request: Request, job_id: UUID) -> Job:
    job = request.app.state.normalization_jobs.get(str(job_id))
    if job is None:
        raise HTTPException(status_code=404, detail="작업이 없습니다. 서버 재시작 후에는 다시 시작하세요. ")
    return job


def public_job(job: Job) -> dict:
    return {
        "job_id": str(job.source.job_id),
        "status": job.status,
        "sheet_name": job.source.sheet_name,
        "address": job.source.address,
        "data_row_count": job.source.row_count - 1,
        "sample_count": len(job.source.samples),
        "analysis": job.analysis,
        "error": job.error,
    }


@router.post("")
async def create_job(payload: CreateJobRequest, request: Request):
    jobs = request.app.state.normalization_jobs
    key = str(payload.job_id)

    existing = jobs.get(key)
    if existing is not None:
        if existing.source != payload:
            raise HTTPException(status_code=409, detail="같은 작업 ID에 다른 데이터가 전달되었습니다. ")
        return public_job(existing)

    if len(jobs) >= 100:
        raise HTTPException(status_code=409, detail="개발용 작업 수 제한에 도달했습니다.")

    job = Job(source=payload)
    jobs[key] = job
    return public_job(job)


@router.get("/{job_id}")
async def read_job(job_id: UUID, request: Request):
    return public_job(find_job(request=request, job_id=job_id))


@router.post("/{job_id}/analyze")
async def analyze_job(job_id: UUID, request: Request):
    job = find_job(request, job_id)

    if job.status == "ANALYZING":
        raise HTTPException(
            status_code=409,
            detail="이미 확인 중입니다. 작업 상태를 조회하세요.",
        )

    if job.status == "REVIEW_READY":
        return public_job(job)

    # 다음 await 전에 상태를 변경해서 중복 실행을 막는다.
    job.status = "ANALYZING"
    job.error = ""

    try:
        source = job.source
        mapping = source.mapping

        samples = [
            {
                "excel_row": source.row_start + index + 2,
                "거래품명": row.cells[mapping.trade_name],
                "신고품명": row.cells[mapping.declared_name],
                "모델규격": row.cells[mapping.model_spec],
            }
            for index, row in enumerate(source.samples)
        ]

        prompt = json.dumps(
            {
                "selected_data_rows": source.row_count - 1,
                "sampling": "선택 범위의 머리글 다음 최대 20행",
                "limitation": (
                    "앞부분 표본이므로 전체 데이터의 분포를 "
                    "대표한다고 볼 수 없습니다."
                ),
                "samples": samples,
            },
            ensure_ascii=False,
        )

        runtime = request.app.state.runtime

        result = await asyncio.wait_for(
            runtime.inspection_graph.ainvoke({
                "messages": [HumanMessage(content=prompt)],
                "request_id": str(job_id),
                "tool_history": [],
            }),
            timeout=runtime.settings.llm.timeout_seconds + 10,
        )

        last = result["messages"][-1]

        if (
            not isinstance(last, AIMessage)
            or last.tool_calls
            or not isinstance(last.content, str)
            or not last.content.strip()
        ):
            raise RuntimeError("유효한 표본 확인 결과가 없습니다.")

        job.analysis = last.content.strip()
        job.status = "REVIEW_READY"

    except asyncio.CancelledError:
        job.status = "FAILED"
        job.error = "분석이 중단됐습니다. 다시 시도하세요."
        raise

    except Exception:
        logger.exception("표본 확인 실패: job_id=%s", job_id)
        job.status = "FAILED"
        job.error = "표본 확인에 실패했습니다. 서버 로그를 확인하세요."

    return public_job(job)
