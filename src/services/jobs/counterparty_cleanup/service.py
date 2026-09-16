"""같은 국가의 해외거래처 후보를 만들고 모델 검토 결과를 검증한다."""
import asyncio
import json
import logging
import re
from difflib import SequenceMatcher
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage

from services.chat_state import WorkFlowState
from services.errors import ConflictError, NotFoundError
from services.jobs.counterparty_cleanup.schemas import (
    CreateJobRequest, Job, ModelReviewResponse, ReviewResult,
)

logger = logging.getLogger(__name__)
SIMILARITY_THRESHOLD = 0.9
REVIEW_BATCH_SIZE = 20


def normalize_company_name(value: str) -> str:
    return re.sub(r"[^\w]", "", value.casefold(), flags=re.UNICODE)


def candidate_groups(job: Job) -> list[dict]:
    source, mapping = job.source, job.source.mapping
    by_country: dict[str, list[dict]] = {}
    exact: dict[tuple[str, str], list[dict]] = {}

    for index, row in enumerate(source.rows):
        country = row.cells[mapping.country_code].strip().casefold()
        original = row.cells[mapping.company_name].strip()
        normalized = normalize_company_name(original)
        if not country or not normalized:
            continue
        item = {
            "excel_row": source.row_start + index + 2,
            "party_code": row.cells[mapping.party_code],
            "country_code": row.cells[mapping.country_code],
            "company_name": original,
            "normalized_name": normalized,
        }
        by_country.setdefault(country, []).append(item)
        exact.setdefault((country, normalized), []).append(item)

    groups = []
    for (country, normalized), rows in exact.items():
        codes = sorted({row["party_code"].strip() for row in rows})
        if len(rows) > 1 and len(codes) > 1:
            groups.append({
                "group_id": f"{country.upper()}-{len(groups) + 1:04d}",
                "country_code": country.upper(),
                "normalized_name": normalized,
                "rows": rows,
                "existing_party_codes": codes,
                "reason": "같은 국가코드에서 정규화 상호가 같고 기존 부호가 여러 개입니다.",
                "decision": "REVIEW_REQUIRED",
            })

    # ponytail: 국가별 O(n²) 비교다. 실제 규모에서 느려질 때 접두어 블록을 추가한다.
    seen: set[tuple[str, ...]] = set()
    for country, rows in by_country.items():
        for index, left in enumerate(rows):
            for right in rows[index + 1:]:
                if left["party_code"].strip() == right["party_code"].strip():
                    continue
                if left["normalized_name"] == right["normalized_name"]:
                    continue
                score = SequenceMatcher(
                    None, left["normalized_name"], right["normalized_name"]
                ).ratio()
                if score < SIMILARITY_THRESHOLD:
                    continue
                key = (
                    country,
                    *sorted((left["normalized_name"], right["normalized_name"])),
                    *sorted((left["party_code"].strip(), right["party_code"].strip())),
                )
                if key in seen:
                    continue
                seen.add(key)
                groups.append({
                    "group_id": f"{country.upper()}-S{len(groups) + 1:04d}",
                    "country_code": country.upper(),
                    "normalized_name": None,
                    "rows": [left, right],
                    "existing_party_codes": sorted({
                        left["party_code"].strip(), right["party_code"].strip()
                    }),
                    "similarity": round(score, 3),
                    "reason": "같은 국가코드에서 정규화 상호의 문자열 유사도가 기준 이상입니다.",
                    "decision": "REVIEW_REQUIRED",
                })
    return groups


def model_review_input(group: dict) -> dict:
    names = list(dict.fromkeys(row["company_name"] for row in group["rows"]))
    return {
        "group_id": group["group_id"],
        "country_code": group["country_code"],
        "company_name_samples": names[:20],
        "company_name_count": len(names),
        "row_count": len(group["rows"]),
        "existing_party_code_count": len(group["existing_party_codes"]),
        "similarity": group.get("similarity"),
        "candidate_reason": group["reason"],
    }


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
        "grouping_policy": (
            "같은 국가코드끼리만 그룹핑. 완전 일치 또는 문자열 유사도 "
            f"{SIMILARITY_THRESHOLD} 이상만 검토 후보로 표시하며 자동 통합하지 않습니다."
        ),
        "candidate_groups": groups,
        "review_results": reviews,
        "final_candidates": final,
        "excluded_candidate_count": len(reviews) - len(final),
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
