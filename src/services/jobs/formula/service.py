import asyncio
import json
import logging
import re
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage

from services.errors import ConflictError, NotFoundError
from services.jobs.formula.schemas import (
    CreateJobRequest, FormulaAction, FormulaApprovalRequest, FormulaPlan,
    FormulaConversationMessage, FormulaHistoryEntry, FormulaPlanningContext,
    FormulaPreview, Job, range_bounds,
)


logger = logging.getLogger(__name__)
FORMULA_JSON_FIELD = re.compile(
    r'("formula"\s*:\s*")(.*?)("\s*,\s*"mode"\s*:)',
    re.DOTALL,
)
SOURCE_DEPENDENT_REQUEST = re.compile(
    r"(?:상품|재고|단가|조회|찾|lookup)", re.IGNORECASE,
)


def validate_source_reference(plan: FormulaPlan, source: CreateJobRequest) -> None:
    if not plan.actions or not SOURCE_DEPENDENT_REQUEST.search(source.instruction):
        return
    first_cell = source.address.rsplit("!", 1)[-1].split(":", 1)[0].replace("$", "")
    match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d*)", first_cell, re.IGNORECASE)
    if match is None:
        raise ValueError("선택한 원본 범위의 첫 셀을 확인할 수 없습니다.")
    reference = re.compile(
        rf"(?<![A-Z0-9_])\$?{re.escape(match.group(1))}"
        rf"\$?{match.group(2)}(?![A-Z0-9_])",
        re.IGNORECASE,
    )
    if not any(reference.search(action.formula) for action in plan.actions):
        raise ValueError("조회·상품 작업 수식이 선택한 원본 키를 참조하지 않습니다.")


def parse_formula_plan(raw: str) -> FormulaPlan:
    try:
        return FormulaPlan.model_validate_json(raw)
    except Exception as original:
        # Repair only an unescaped quote inside the known formula field.
        # Other malformed JSON remains a planning failure.
        match = FORMULA_JSON_FIELD.search(raw)
        if match is None:
            raise original
        repaired = (
            raw[:match.start(1)]
            + match.group(1)[:-1]
            + json.dumps(match.group(2), ensure_ascii=False)
            + match.group(3)[1:]
            + raw[match.end(3):]
        )
        return FormulaPlan.model_validate_json(repaired)


def find_job(jobs: dict, job_id: UUID) -> Job:
    job = jobs.get(str(job_id))
    if not isinstance(job, Job):
        raise NotFoundError("수식 작업이 없습니다. 다시 시작하세요.")
    return job


def public_job(job: Job) -> dict:
    return {
        "job_id": str(job.source.job_id),
        "conversation_id": str(job.source.conversation_id),
        "task_type": job.task_type,
        "status": job.status,
        "sheet_name": job.source.sheet_name,
        "address": job.source.address,
        "instruction": job.source.instruction,
        "preview": (
            job.preview.model_dump(mode="json") if job.preview else None
        ),
        "clarification": (
            job.preview.plan.clarification if job.preview else None
        ),
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
        "instruction": public["instruction"],
        "analysis": job.preview.plan.summary if job.preview else job.error,
        "plan": job.preview.plan.model_dump(mode="json") if job.preview else None,
        "analysis_truncated": False,
    }


async def create_job(payload: CreateJobRequest, repository, jobs: dict) -> dict:
    cid, key = str(payload.conversation_id), str(payload.job_id)
    async with repository.edit(cid) as conversation:
        existing = jobs.get(key)
        if existing is not None:
            if not isinstance(existing, Job) or existing.source != payload:
                raise ConflictError("같은 작업 ID에 다른 수식 요청이 전달됐습니다.")
            return public_job(existing)
        if len(jobs) >= 100:
            raise ConflictError("개발용 작업 수 제한에 도달했습니다.")
        previous = jobs.get(conversation.workflow.active_job_id)
        history = [
            FormulaHistoryEntry(
                instruction=item.source.instruction,
                sheet_name=item.source.sheet_name,
                source_address=item.source.address,
                status=item.status,
                plan=item.preview.plan,
            )
            for item in jobs.values()
            if (
                isinstance(item, Job)
                and item.preview is not None
                and item.source.conversation_id == payload.conversation_id
                and item.source.sheet_name == payload.sheet_name
            )
        ][-5:]
        recent_messages = []
        for turn in conversation.turns[-5:]:
            recent_messages.extend([
                FormulaConversationMessage(role="user", content=turn.question),
                FormulaConversationMessage(role="assistant", content=turn.answer),
            ])
        planning_context = FormulaPlanningContext(
            previous_instruction=(
                previous.source.instruction if isinstance(previous, Job) else None
            ),
            previous_sheet_name=(
                previous.source.sheet_name if isinstance(previous, Job) else None
            ),
            previous_address=(
                previous.source.address if isinstance(previous, Job) else None
            ),
            previous_status=(
                previous.status if isinstance(previous, Job) else None
            ),
            previous_plan=(
                previous.preview.plan
                if isinstance(previous, Job) and previous.preview else None
            ),
            previous_plans=tuple(history),
            recent_conversation=tuple(recent_messages),
        )
        job = Job(source=payload, planning_context=planning_context)
        jobs[key] = job
        conversation.workflow.active_job_id = key
        conversation.workflow.task_type = "formula"
        conversation.workflow.pending_intent = None
        conversation.workflow.phase = "JOB_ATTACHED"
        return public_job(job)


async def plan_job(job_id: UUID, jobs: dict, runtime) -> dict:
    job = find_job(jobs, job_id)
    if job.status == "PLANNING":
        raise ConflictError("이미 수식 계획을 만들고 있습니다.")
    if job.status in {"PREVIEW_READY", "NEEDS_INPUT"}:
        return public_job(job)

    job.status, job.error = "PLANNING", ""
    try:
        source = job.source
        response = await asyncio.wait_for(
            runtime.formula_graph.ainvoke({
                "messages": [HumanMessage(content=json.dumps({
                    "instruction": source.instruction,
                    "context": (
                        job.planning_context.model_dump(mode="json")
                        if job.planning_context else None
                    ),
                    "selection": {
                        "worksheet_id": source.worksheet_id,
                        "sheet_name": source.sheet_name,
                        "address": source.address,
                        "row_start_zero_based": source.row_start,
                        "column_start_zero_based": source.column_start,
                        "row_count": source.row_count,
                        "column_count": source.column_count,
                        "samples": [row.model_dump() for row in source.samples],
                    },
                    "sheet_context": (
                        source.sheet_context.model_dump(mode="json")
                        if source.sheet_context else None
                    ),
                }, ensure_ascii=False))],
                "request_id": str(job_id),
                "tool_history": [],
            }),
            timeout=runtime.settings.llm.timeout_seconds + 10,
        )
        last = response["messages"][-1]
        if (
            not isinstance(last, AIMessage)
            or last.tool_calls
            or not isinstance(last.content, str)
        ):
            raise ValueError("유효한 수식 계획이 없습니다.")
        plan = parse_formula_plan(last.content.strip())
        validate_source_reference(plan, source)
        job.preview = FormulaPreview(plan=plan)
        job.approved_preview_id = None
        job.status = "PREVIEW_READY" if plan.actions else "NEEDS_INPUT"
    except asyncio.CancelledError:
        job.status = "FAILED"
        job.error = "수식 계획 생성이 중단됐습니다. 다시 시도하세요."
        raise
    except Exception:
        logger.exception("수식 계획 생성 실패: job_id=%s", job_id)
        job.status = "FAILED"
        job.error = "안전하게 실행할 수식 계획을 만들지 못했습니다. 요청을 구체적으로 다시 작성하세요."
    return public_job(job)


def approve_preview(
    job_id: UUID,
    preview_id: UUID,
    payload: FormulaApprovalRequest | None,
    jobs: dict,
) -> FormulaPreview:
    job = find_job(jobs, job_id)
    if (
        job.status != "PREVIEW_READY"
        or job.preview is None
        or job.preview.preview_id != preview_id
    ):
        raise ConflictError("확인한 수식 계획이 현재 미리보기와 다릅니다.")
    if payload is not None:
        requested_ranges = payload.ranges()
        if len(requested_ranges) != len(job.preview.plan.actions):
            raise ConflictError("결과 열 개수가 수식 계획과 다릅니다.")
        revised_actions = []
        for action, target_range in zip(
            job.preview.plan.actions, requested_ranges, strict=True,
        ):
            original = range_bounds(action.target_range)
            requested = range_bounds(target_range)
            if original[0] != requested[0] or original[2] != requested[2]:
                raise ConflictError("결과 범위는 원본과 같은 행 범위여야 합니다.")
            revised_actions.append(FormulaAction.model_validate({
                **action.model_dump(),
                "target_range": target_range,
                "anchor_cell": target_range.split(":", 1)[0],
            }))
        job.preview = FormulaPreview(
            preview_id=job.preview.preview_id,
            plan=job.preview.plan.model_copy(update={
                "actions": tuple(revised_actions),
            }),
        )
    job.approved_preview_id = preview_id
    return job.preview


def complete_job(job_id: UUID, preview_id: UUID, jobs: dict) -> dict:
    job = find_job(jobs, job_id)
    if job.approved_preview_id != preview_id:
        raise ConflictError("승인된 수식 계획만 완료할 수 있습니다.")
    job.status = "APPLIED"
    return public_job(job)
