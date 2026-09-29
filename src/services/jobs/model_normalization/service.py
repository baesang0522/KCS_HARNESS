import asyncio
import json
import logging
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage

from utils.dataframe_utils import (
    normalize_fullwidth_ascii,
    text_rows_to_dataframe,
)
from services.chat_state import WorkFlowState
from services.errors import ConflictError, NotFoundError
from services.jobs.model_normalization.rule_engine import (
    build_preview,
    build_rule_examples,
)
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

    dataframe = text_rows_to_dataframe(
        rows=(
            (
                row.cells[mapping.trade_name],
                row.cells[mapping.declared_name],
                row.cells[mapping.model_spec],
            )
            for row in source.rows
        ),
        columns=(
            "trade_name",
            "declared_name",
            "model_spec",
        ),
    )

    # Excel 행 번호는 1부터 시작하고 선택 범위 첫 행은 머리글이다.
    first_data_row = source.row_start + 2
    dataframe["excel_row"] = range(
        first_data_row,
        first_data_row + len(dataframe),
    )

    # 공백 등을 정제하기 전의 원본 세 값으로 집계한다.
    # 모델규격만 같고 품명이 다르면 서로 다른 그룹이다.
    grouped = (
        dataframe
        .groupby(
            ["trade_name", "declared_name", "model_spec"],
            sort=False,
            dropna=False,
            as_index=False,
        )
        .agg(
            excel_row=("excel_row", "min"),
            count=("excel_row", "size"),
        )
    )

    # 원본 DataFrame은 집계 이후 더 이상 사용하지 않는다.
    del dataframe

    grouped["sort_key"] = (
        normalize_fullwidth_ascii(grouped["model_spec"])
        .str.casefold()
        .str.replace(r"\s+", "", regex=True)
    )
    grouped = grouped.sort_values(
        ["sort_key", "trade_name", "declared_name", "model_spec", "excel_row"],
    )

    batches, batch, batch_chars = [], [], 2

    for row in grouped.itertuples(index=False):
        record = {
            # 동일 조합의 최초 원본 행 번호를 작업 내 고유 ID로 사용함.
            "record_id": int(row.excel_row),
            "excel_row": int(row.excel_row),
            "거래품명": row.trade_name,
            "신고품명": row.declared_name,
            "모델규격": row.model_spec,
            "count": int(row.count),
            "context_only": False,
        }

        # Json 배열의 구분자 공간까지 보수적으로 계산
        record_chars = len(json.dumps(record, ensure_ascii=False)) + 2
        if record_chars + 2 > 10000:
            raise ValueError("한 항목이 분석 입력 길이 제한을 초과했습니다.")

        if batch and (
            len(batch) >= 100
            or batch_chars + record_chars > 10000
        ):
            batches.append(batch)

            # 앞 배치의 마지막 10개를 비교 참고용으로 다시 전달
            # 복사로 전달하므로 앞 배치의 context_only 값은 변경되지 않음
            batch = [
                dict(item, context_only=False) for item in batch[-10:]
            ]
            batch_chars = 2 + sum(
                len(json.dumps(item, ensure_ascii=False)) + 2 for item in batch
            )

            # 새 항목이 반드시 들어가도록 필요하면 겹침 개수를 감소
            while batch and batch_chars + record_chars > 10000:
                removed = batch.pop(0)
                batch_chars -= (len(json.dumps(removed, ensure_ascii=False)) + 2)

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
            "선택 영역 전체. 동일한 세 값의 출현 횟수를 집계하고, "
            "모델규격의 정렬용 키로 정렬한 뒤 "
            "일부가 겹치는 묶음으로 분석하여 종합함. "
            "원본 데이터와 출력 행 순서는 유지함."
        ),
        "preview_row_count": (
            job.preview.row_count if job.preview else 0
        ),
        "approved_preview_id": (
            str(job.approved_preview_id)
            if job.approved_preview_id else None
        ),
        "preview_rules": (
            [
                rule.operation
                for rule in job.preview.rule_set.rules
            ]
            if job.preview else []
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
        "rule_examples": job.rule_examples,
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

        job = Job(source=payload, rule_examples=build_rule_examples(payload))
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
                },
            )

            summaries.append(summary)
            job.analyzed_row_count += sum(
                record["count"] for record in records if not record["context_only"]
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
