"""같은 국가의 해외거래처 후보를 만들고 모델 검토 결과를 검증한다."""
import asyncio
import json
import logging
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage

from services.chat_state import WorkFlowState
from services.errors import ConflictError, ModelProcessingError, NotFoundError
from services.jobs.counterparty_cleanup.rule_engine import candidate_groups, model_review_input
from services.jobs.counterparty_cleanup.schemas import (
    CounterpartyPolicy, CounterpartyPreview, CreateJobRequest, Job,
    ModelReviewResponse, PolicySuggestion, PolicySuggestionRequest,
    PreviewRequest, PreviewRow, ReviewResult,
)

logger = logging.getLogger(__name__)
REVIEW_BATCH_SIZE = 20


def find_job(jobs: dict, job_id: UUID, conversation_id: UUID | None = None) -> Job:
    job = jobs.get(str(job_id))
    if (not isinstance(job, Job) or
            (conversation_id is not None and job.source.conversation_id != conversation_id)):
        raise NotFoundError("현재 대화의 해외거래처 작업이 없습니다.")
    return job


def public_job(job: Job) -> dict:
    source = job.source
    countries = sorted({
        row.cells[source.mapping.country_code].strip().upper()
        for row in source.rows if row.cells[source.mapping.country_code].strip()
    })
    missing = {
        role: sum(not row.cells[index].strip() for row in source.rows)
        for role, index in source.mapping.model_dump().items()
    }
    groups = candidate_groups(job)
    reviews = [result.model_dump() for result in job.review_results]
    final = [item for item in reviews if item["decision"] != "LIKELY_DIFFERENT"]
    return {
        "job_id": str(source.job_id),
        "conversation_id": str(source.conversation_id),
        "task_type": job.task_type,
        "status": job.status,
        "sheet_name": source.sheet_name,
        "address": source.address,
        "data_row_count": len(source.rows),
        "headers": source.headers,
        "mapping": source.mapping.model_dump(),
        "samples": [row.model_dump() for row in source.rows[:20]],
        "country_codes": countries,
        "missing_counts": missing,
        "same_country_only": True,
        "policy": job.policy.model_dump(),
        "policy_suggestion": (
            job.policy_suggestion.model_dump() if job.policy_suggestion else None
        ),
        "grouping_policy": (
            "같은 국가코드끼리만 그룹핑. 완전 일치 또는 문자열 유사도 "
            f"{job.policy.similarity_threshold} 이상만 검토 후보로 표시하며 자동 통합하지 않습니다."
        ),
        "candidate_groups": groups,
        "review_results": reviews,
        "final_candidates": final,
        "excluded_candidate_count": len(reviews) - len(final),
        "preview_id": str(job.preview.preview_id) if job.preview else None,
        "approved_preview_id": (
            str(job.approved_preview_id) if job.approved_preview_id else None
        ),
        "error": job.error,
    }


def job_context(job: Job) -> dict:
    public = public_job(job)
    return {
        "job_id": public["job_id"],
        "task_type": job.task_type,
        "status": job.status,
        "sheet_name": public["sheet_name"],
        "address": public["address"],
        "data_row_count": public["data_row_count"],
        "same_country_only": True,
        "policy": public["policy"],
        "grouping_policy": public["grouping_policy"],
        "samples": public["samples"],
        "final_candidate_count": len(public["final_candidates"]),
        "final_candidates": public["final_candidates"][:20],
        "final_candidates_truncated": len(public["final_candidates"]) > 20,
        "error": job.error,
    }


def attach_job(state: WorkFlowState, job_id: str) -> None:
    state.active_job_id = job_id
    state.task_type = "counterparty_cleanup"
    state.pending_intent = None
    state.phase = "JOB_ATTACHED"


async def create_job(payload: CreateJobRequest, repository, jobs: dict) -> dict:
    cid, key = str(payload.conversation_id), str(payload.job_id)
    async with repository.edit(cid) as conversation:
        existing = jobs.get(key)
        if existing is not None:
            if not isinstance(existing, Job) or existing.source != payload:
                raise ConflictError("같은 작업 ID에 다른 데이터가 전달됐습니다.")
            return public_job(existing)
        active = jobs.get(conversation.workflow.active_job_id)
        if active is not None and active.status in {"ANALYZING", "REVIEWING"}:
            raise ConflictError("현재 작업 분석이 끝난 뒤 다시 선택하세요.")
        if len(jobs) >= 100:
            raise ConflictError("개발용 작업 수 제한에 도달했습니다.")
        job = Job(source=payload.model_copy(deep=True))
        jobs[key] = job
        attach_job(conversation.workflow, key)
        return public_job(job)


async def review_candidates(
    job_id: UUID, conversation_id: UUID | None, jobs: dict, runtime,
):
    job = find_job(jobs, job_id, conversation_id)
    if job.status == "REVIEWING":
        raise ConflictError("이미 모델이 후보를 검토 중입니다.")
    if job.status == "REVIEW_READY":
        return public_job(job)
    groups = candidate_groups(job)
    if not groups:
        job.review_results = []
        job.status = "REVIEW_READY"
        job.error = ""
        return public_job(job)

    job.status, job.error = "REVIEWING", ""
    results: list[ReviewResult] = []
    try:
        for start in range(0, len(groups), REVIEW_BATCH_SIZE):
            batch = groups[start:start + REVIEW_BATCH_SIZE]
            prompt = json.dumps({
                "rule": "같은 국가코드 안에서만 검토하며 승인하거나 부호를 변경하지 않음",
                "candidates": [model_review_input(group) for group in batch],
            }, ensure_ascii=False)
            response = await asyncio.wait_for(
                runtime.counterparty_review_graph.ainvoke({
                    "messages": [HumanMessage(content=prompt)],
                    "request_id": f"{job_id}:{start // REVIEW_BATCH_SIZE + 1}",
                    "tool_history": [],
                }),
                timeout=runtime.settings.llm.timeout_seconds + 10,
            )
            last = response["messages"][-1]
            if (not isinstance(last, AIMessage) or last.tool_calls
                    or not isinstance(last.content, str)):
                raise ValueError("유효한 모델 검토 결과가 없습니다.")
            reviewed = ModelReviewResponse.model_validate_json(last.content)
            expected = {group["group_id"] for group in batch}
            received = [item.group_id for item in reviewed.reviews]
            if len(received) != len(set(received)) or set(received) != expected:
                raise ValueError("모델이 후보 식별자를 누락하거나 변경했습니다.")
            by_id = {group["group_id"]: group for group in batch}
            for item in reviewed.reviews:
                group = by_id[item.group_id]
                results.append(ReviewResult(
                    **item.model_dump(), country_code=group["country_code"],
                    rows=group["rows"],
                    existing_party_codes=group["existing_party_codes"],
                    similarity=group.get("similarity"),
                ))
        job.review_results = results
        job.status = "REVIEW_READY"
    except asyncio.CancelledError:
        job.status = "REVIEW_FAILED"
        job.error = "모델 검토가 중단됐습니다. 다시 시도하세요."
        raise
    except Exception:
        logger.exception("해외거래처 후보 검토 실패: job_id=%s", job_id)
        job.status = "REVIEW_FAILED"
        job.error = "모델 검토에 실패했습니다. 다시 시도하거나 서버 로그를 확인하세요."
    return public_job(job)


async def suggest_policy(
    job_id: UUID, payload: PolicySuggestionRequest, jobs: dict, runtime,
) -> PolicySuggestion:
    job = find_job(jobs, job_id)
    source, mapping = job.source, job.source.mapping
    names = list(dict.fromkeys(
        row.cells[mapping.company_name].strip()
        for row in source.rows
        if row.cells[mapping.company_name].strip()
    ))[:100]
    prompt = json.dumps({
        "instruction": payload.instruction.strip(),
        "current_policy": job.policy.model_dump(),
        "company_name_samples": names,
        "fixed_rule": "국가코드가 같은 행만 비교",
    }, ensure_ascii=False)
    try:
        response = await asyncio.wait_for(
            runtime.counterparty_policy_graph.ainvoke({
                "messages": [HumanMessage(content=prompt)],
                "request_id": f"{job_id}:policy",
                "tool_history": [],
            }),
            timeout=runtime.settings.llm.timeout_seconds + 10,
        )
        last = response["messages"][-1]
        if (not isinstance(last, AIMessage) or last.tool_calls
                or not isinstance(last.content, str)):
            raise ValueError("유효한 정제 기준 추천이 없습니다.")
        suggestion = PolicySuggestion.model_validate_json(last.content)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        logger.exception("해외거래처 정제 기준 추천 실패: job_id=%s", job_id)
        raise ModelProcessingError("정제 기준 추천에 실패했습니다. 다시 시도하세요.") from error
    job.policy_suggestion = suggestion
    return suggestion


def apply_policy(job_id: UUID, policy: CounterpartyPolicy, jobs: dict) -> dict:
    job = find_job(jobs, job_id)
    job.policy = policy
    job.policy_suggestion = None
    job.review_results = []
    job.preview = None
    job.approved_preview_id = None
    job.status = "CANDIDATES_READY"
    job.error = ""
    return public_job(job)


async def preview_job(
    job_id: UUID, payload: PreviewRequest, jobs: dict,
) -> CounterpartyPreview:
    job = find_job(jobs, job_id)
    if job.status != "REVIEW_READY":
        raise ConflictError("모델 검토를 완료한 뒤 승인 내용을 미리보세요.")

    candidates = {
        result.group_id: result for result in job.review_results
        if result.decision != "LIKELY_DIFFERENT"
    }
    decisions = {item.group_id: item for item in payload.decisions}
    if len(decisions) != len(payload.decisions) or set(decisions) != set(candidates):
        raise ConflictError("현재 최종 후보 전체를 승인 또는 제외로 확인하세요.")

    approved_rows: dict[int, tuple[str, str]] = {}
    for group_id, decision in decisions.items():
        if decision.decision == "EXCLUDE":
            continue
        candidate = candidates[group_id]
        representative = decision.representative_party_code.strip()
        if representative not in candidate.existing_party_codes:
            raise ConflictError("대표 해외거래처부호는 후보의 기존 부호 중에서 선택하세요.")
        for row in candidate.rows:
            existing = approved_rows.get(row["excel_row"])
            if existing and existing[0] != representative:
                raise ConflictError(
                    f"{row['excel_row']}행이 서로 다른 대표 부호로 중복 승인됐습니다."
                )
            approved_rows[row["excel_row"]] = (representative, group_id)

    source, mapping = job.source, job.source.mapping
    ordered = tuple(
        PreviewRow(
            group_id=approved_rows.get(excel_row, ("", ""))[1],
            excel_row=excel_row,
            country_code=row.cells[mapping.country_code],
            company_name=row.cells[mapping.company_name],
            original_party_code=row.cells[mapping.party_code],
            representative_party_code=approved_rows.get(
                excel_row, (row.cells[mapping.party_code], "")
            )[0],
            changed=(
                row.cells[mapping.party_code].strip()
                != approved_rows.get(
                    excel_row, (row.cells[mapping.party_code].strip(), "")
                )[0]
            ),
        )
        for index, row in enumerate(source.rows)
        if (excel_row := source.row_start + index + 2)
    )
    preview = CounterpartyPreview(
        decisions=payload.decisions,
        approved_group_count=sum(
            item.decision == "APPROVE" for item in payload.decisions
        ),
        excluded_group_count=sum(
            item.decision == "EXCLUDE" for item in payload.decisions
        ),
        row_count=len(ordered),
        changed_count=sum(row.changed for row in ordered),
        rows=ordered,
        policy=job.policy,
    )
    job.preview = preview
    job.approved_preview_id = None
    return preview


def approve_preview(
    job_id: UUID, preview_id: UUID, jobs: dict,
) -> CounterpartyPreview:
    job = find_job(jobs, job_id)
    if (
        job.status != "REVIEW_READY"
        or job.preview is None
        or job.preview.preview_id != preview_id
    ):
        raise ConflictError("확인한 미리보기가 현재 결과와 다릅니다. 다시 확인하세요.")
    return job.preview


def complete_preview(job_id: UUID, preview_id: UUID, jobs: dict) -> CounterpartyPreview:
    preview = approve_preview(job_id, preview_id, jobs)
    job = find_job(jobs, job_id)
    job.approved_preview_id = preview_id
    return preview
