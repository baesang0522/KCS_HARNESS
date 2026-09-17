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


def get_rows(
    job: Job,
    start: int = 0,
    stop: int | None = None,
) -> list[NormalizationRow]:
    source = job.source
    mapping = source.mapping

    return [
        NormalizationRow(
            excel_row=source.row_start + index + 2,
            trade_name=row.cells[mapping.trade_name],
            declared_name=row.cells[mapping.declared_name],
            model_spec=row.cells[mapping.model_spec],
        ) for index, row in enumerate(source.rows[start:stop], start=start,)
    ]


def analysis_batches(job: Job) -> list[list[dict]]:
    source = job.source
    mapping = source.mapping
    grouped = {}

    # 세 값이 완전히 같은 경우에만 합친다.
    # 모델규격만 같고 품명이 다르면 별도 분석 대상으로 유지한다.
    for index, row in enumerate(source.rows):
        key = (
            row.cells[mapping.trade_name],
            row.cells[mapping.declared_name],
            row.cells[mapping.model_spec],
        )

        if key not in grouped:
            grouped[key] = {
                "excel_row": source.row_start + index + 2,
                "거래품명": key[0],
                "신고품명": key[1],
                "모델규격": key[2],
                "count": 0,
            }
        grouped[key]["count"] += 1

    batches = []
    batch = []
    batch_chars = 0

    for record in grouped.values():
        record_chars = len(json.dumps(record, ensure_ascii=False))

        if batch and (
                len(batch) >= 100
                or batch_chars + record_chars > 10000
        ):
            batches.append(batch)
            batch = []
            batch_chars = 0

        batch.append(record)
        batch_chars += record_chars

    if batch:
        batches.append(batch)

    return batches


async def inspect_payload(runtime, job_id: UUID, payload: dict) -> str:
    result = await asyncio.wait_for(
        runtime.inspection_graph.ainvoke({
            "messages": [
                HumanMessage(
                    content=json.dumps(payload, ensure_ascii=False),
                )
            ],
            "request_id": str(job_id),
            "tool_history": [],
        }),
        timeout=runtime.settings.llm.timeout_seconds + 10
    )
    last = result["messages"][-1]

    if (
        not isinstance(last, AIMessage)
        or last.tool_calls
        or not isinstance(last.content, str)
        or not last.content.strip()
    ):
        raise RuntimeError("유효한 분석 결과가 없습니다.")

    content = last.content.strip()
    if len(content) > 3000:
        raise RuntimeError("분석 결과가 최대 길이 3000자를 초과했습니다.")
    return content


def job_context(job: Job) -> dict:
    return {
        **public_job(job),
        "task_type": "model_normalization",
        "headers": list(job.source.headers),
        "column_mapping": job.source.mapping.model_dump(),
        "analysis_scope": (
            "선택 영역 전체. 동일한 세 값은 출현 횟수를 집계하고 "
            "모든 고유 조합을 분할 분석한 뒤 종합함."
        ),
        "preview_row_count": (
            job.preview.row_count if job.preview else 0
        ),
        "approved_preview_id": (
            str(job.approved_preview_id)
            if job.approved_preview_id else None
        ),
    }


def find_job(jobs: dict, job_id: UUID) -> Job:
    job = jobs.get(str(job_id))
    if not isinstance(job, Job):
        raise NotFoundError("작업이 없습니다. 서버 재시작 후에는 다시 시작하세요. ")
    return job


def public_job(job: Job) -> dict:
    return {
        "conversation_id": str(job.source.conversation_id),
        "job_id": str(job.source.job_id),
        "status": job.status,
        "sheet_name": job.source.sheet_name,
        "address": job.source.address,
        "data_row_count": len(job.source.rows),
        "analyzed_row_count": job.analyzed_row_count,
        "processed_row_count": job.processed_row_count,
        "analysis_batch_count": job.analysis_batch_count,
        "completed_analysis_batches": job.completed_analysis_batches,
        "analysis_phase": job.analysis_phase,
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

        if (
                active_job is not None
                and active_job.status in {"ANALYZING", "REVIEWING", "PREVIEWING"}
        ):
            raise ConflictError(
                "현재 작업을 처리 중입니다. 완료 후 다시 선택하세요."
            )

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

    if job.status in {"ANALYZING", "PREVIEWING"}:
        raise ConflictError("이미 처리 중입니다. 작업 상태를 조회하세요.")

    if job.status == "REVIEW_READY":
        return public_job(job)

    job.status = "ANALYZING"
    job.error = ""
    job.analysis = ""
    job.analyzed_row_count = 0
    job.completed_analysis_batches = 0
    job.analysis_batch_count = 0
    job.analysis_phase = "INSPECTING"

    try:
        batches = analysis_batches(job)
        job.analysis_batch_count = len(batches)
        summaries = []

        for index, records in enumerate(batches):
            summary = await inspect_payload(
                runtime,
                job_id,
                {
                    "phase": "inspect",
                    "selected_data_rows": len(job.source.rows),
                    "batch_index": index + 1,
                    "batch_count": len(batches),
                    "records": records,
                    "instruction": (
                        "전체 데이터 중 한 묶음입니다. "
                        "각 항목의 count는 동일한 세 값의 출현 횟수입니다. "
                        "관찰한 패턴, 의미 있는 차이, 예외를 보고하세요. "
                        "이 묶음만으로 실행 규칙을 확정하지 마세요."
                    ),
                },
            )

            summaries.append(summary)
            job.analyzed_row_count += sum(
                record["count"] for record in records
            )
            job.completed_analysis_batches += 1

        job.analysis_phase = "COMBINING"

        # 모든 분석 결과를 종합한다.
        # 종합 결과도 커질 수 있으므로 최대 세 개씩 단계적으로 합친다.
        while len(summaries) > 1:
            combined = []

            for offset in range(0, len(summaries), 3):
                group = summaries[offset:offset + 3]

                if len(group) == 1:
                    combined.append(group[0])
                    continue

                combined.append(
                    await inspect_payload(
                        runtime,
                        job_id,
                        {
                            "phase": "combine",
                            "selected_data_rows": len(job.source.rows),
                            "reports": group,
                            "instruction": (
                                "서로 다른 묶음의 분석을 종합하세요. "
                                "충돌하는 판단과 예외를 명시하고, "
                                "같은 표기를 서로 다르게 처리하도록 "
                                "규칙을 확정하지 마세요. "
                                "실행 규칙은 별도 승인 대상입니다."
                            ),
                        },
                    )
                )

            summaries = combined

        job.analysis = summaries[0]
        job.analysis_phase = "DONE"
        job.status = "REVIEW_READY"

    except asyncio.CancelledError:
        job.status = "FAILED"
        job.error = "전체 분석이 중단됐습니다. 다시 시도하세요."
        raise

    except Exception:
        logger.exception("전체 분석 실패: job_id=%s", job_id)
        job.status = "FAILED"
        job.error = (
            "전체 분석을 완료하지 못했습니다. "
            "서버 로그를 확인한 뒤 다시 시도하세요."
        )

    return public_job(job)


async def preview_job(
    job_id: UUID,
    payload: RuleSet,
    jobs: dict,
) -> NormalizationPreview:
    job = find_job(jobs, job_id)

    if job.status != "REVIEW_READY":
        raise ConflictError(
            "선택 영역 전체 분석을 완료한 뒤 미리보기를 요청하세요."
        )

    if job.preview is not None and job.preview.rule_set == payload:
        return job.preview

    job.preview = None
    job.approved_preview_id = None
    job.processed_row_count = 0
    job.status = "PREVIEWING"
    job.error = ""

    try:
        results = []
        changed_count = 0

        # 모든 묶음에 동일한 규칙 세트를 적용한다.
        for offset in range(0, len(job.source.rows), 1000):
            chunk = build_preview(
                rows=get_rows(job, offset, offset + 1000),
                rule_set=payload,
            )

            results.extend(chunk.rows)
            changed_count += chunk.changed_count
            job.processed_row_count = len(results)

            # 다른 요청과 진행 상태 조회가 실행될 기회를 준다.
            await asyncio.sleep(0)

        job.preview = NormalizationPreview(
            rule_set=payload,
            row_count=len(results),
            changed_count=changed_count,
            rows=tuple(results),
        )

        return job.preview

    except asyncio.CancelledError:
        job.error = "미리보기 생성이 중단됐습니다. 다시 요청하세요."
        raise

    except Exception:
        job.error = "미리보기 생성에 실패했습니다. 다시 요청하세요."
        raise

    finally:
        job.status = "REVIEW_READY"


def approve_preview(
    job_id: UUID,
    preview_id: UUID,
    jobs: dict,
) -> NormalizationPreview:
    job = find_job(jobs, job_id)

    if (
        job.status != "REVIEW_READY"
        or job.preview is None
        or job.preview.preview_id != preview_id
    ):
        raise ConflictError(
            "확인한 미리보기가 현재 결과와 다릅니다. 다시 확인하세요"
        )

    job.approved_preview_id = preview_id
    return job.preview
