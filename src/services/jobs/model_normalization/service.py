import asyncio
import json
import logging
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage

from services.chat_state import WorkFlowState
from services.errors import ConflictError, NotFoundError
from services.jobs.model_normalization.rule_engine import build_preview
from services.jobs.model_normalization.schemas import (
    CreateJobRequest, Job, NormalizationPreview, NormalizationRow, RuleSet,
)

logger = logging.getLogger(__name__)


def get_sample_rows(job: Job) -> list[NormalizationRow]:
    source = job.source
    mapping = source.mapping

    return [
        NormalizationRow(
            excel_row=source.row_start + index + 2,
            trade_name=row.cells[mapping.trade_name],
            declared_name=row.cells[mapping.declared_name],
            model_spec=row.cells[mapping.model_spec],
        )
        for index, row in enumerate(source.samples)
    ]


def sample_context(job: Job) -> list[dict]:
    return [
        {
            "excel_row": row.excel_row,
            "거래품명": row.trade_name,
            "신고품명": row.declared_name,
            "모델규격": row.model_spec,
        }
        for row in get_sample_rows(job)
    ]


def job_context(job: Job) -> dict:
    source = job.source
    analysis = job.analysis or ""
    return {
        "job_id": str(source.job_id),
        "task_type": "model_normalization",
        "status": job.status,
        "sheet_name": source.sheet_name,
        "address": source.address,
        "data_row_count": source.row_count - 1,
        "headers": list(source.headers),
        "column_mapping": source.mapping.model_dump(),
        "sampling": "선택 범위의 머리글 다음 최대 20행",
        "samples": sample_context(job),
        "analysis": analysis[:12000],
        "analysis_truncated": len(analysis) > 12000,
        "error": job.error,
    }


def find_job(jobs: dict, job_id: UUID) -> Job:
    job = jobs.get(str(job_id))
    if job is None:
        raise NotFoundError("작업이 없습니다. 서버 재시작 후에는 다시 시작하세요. ")
    return job


def public_job(job: Job) -> dict:
    return {
        "conversation_id": str(job.source.conversation_id),
        "job_id": str(job.source.job_id),
        "status": job.status,
        "sheet_name": job.source.sheet_name,
        "address": job.source.address,
        "data_row_count": job.source.row_count - 1,
        "sample_count": len(job.source.samples),
        "analysis": job.analysis,
        "error": job.error,
    }


def attach_model_job(
        state: WorkFlowState,
        job_id: str,
) -> None:
    state.active_job_id = job_id
    state.task_type = "model_normalization"
    state.pending_intent = None
    state.phase = "JOB_ATTACHED"


async def create_job(payload: CreateJobRequest, repository, jobs: dict) -> dict:
    cid = str(payload.conversation_id)
    key = str(payload.job_id)

    async with repository.edit(cid) as conversation:
        existing = jobs.get(key)

        if existing is not None:
            if existing.source != payload:
                raise ConflictError("같은 작업 ID에 다른 데이터가 전달됐습니다.")

            # 과거 요청 재시도가 현재 작업을 되돌리지 않게 한다.
            return public_job(existing)

        active_id = conversation.workflow.active_job_id
        active_job = jobs.get(active_id) if active_id else None

        if active_job is not None and active_job.status == "ANALYZING":
            raise ConflictError("현재 작업을 분석 중입니다. 완료 후 다시 선택하세요.")

        if len(jobs) >= 100:
            raise ConflictError("개발용 작업 수 제한에 도달했습니다.")

        job = Job(source=payload)
        jobs[key] = job

        attach_model_job(
            conversation.workflow,
            job_id=key,
        )

        return public_job(job)


async def analyze_job(job_id: UUID, jobs: dict, runtime):
    job = find_job(jobs, job_id)

    if job.status == "ANALYZING":
        raise ConflictError("이미 확인 중입니다. 작업 상태를 조회하세요.")

    if job.status == "REVIEW_READY":
        return public_job(job)

    # 다음 await 전에 상태를 변경해서 중복 실행을 막는다.
    job.status = "ANALYZING"
    job.error = ""

    try:
        source = job.source

        samples = sample_context(job)

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


async def preview_job(
    job_id: UUID,
    payload: RuleSet,
    jobs: dict,
) -> NormalizationPreview:
    job = find_job(jobs, job_id)

    if job.status != "REVIEW_READY":
        raise ConflictError("표본 분석을 완료한 뒤 미리보기를 요청하세요.")

    rows = get_sample_rows(job)

    return build_preview(
        rows=rows,
        rule_set=payload,
    )
