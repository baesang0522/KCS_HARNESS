import asyncio
import json
import logging
import re
from uuid import UUID

from services.errors import ConflictError, NotFoundError
from services.formula.schemas import (
    CreateFormulaJobRequest, FormulaAction, FormulaApprovalRequest, FormulaPlan,
    FormulaConversationMessage, FormulaHistoryEntry, FormulaPlanningContext,
    FormulaPreview, FormulaJob, FormulaCompletion, range_bounds,
)


logger = logging.getLogger(__name__)
FORMULA_JSON_FIELD = re.compile(
    r'("formula"\s*:\s*")(.*?)("\s*,\s*"mode"\s*:)',
    re.DOTALL,
)
SOURCE_DEPENDENT_REQUEST = re.compile(
    r"(?:상품|재고|단가|조회|찾|lookup)", re.IGNORECASE,
)


def validate_source_reference(plan: FormulaPlan, source: CreateFormulaJobRequest) -> None:
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


def validate_output_scope(plan: FormulaPlan, source: CreateFormulaJobRequest) -> None:
    for action in plan.actions:
        first, col, last, _ = range_bounds(action.target_range)
        if first < source.row_start + 1 or last > source.row_start + source.row_count:
            raise ValueError("수식 결과는 선택한 데이터 행 범위 안에 있어야 합니다.")
        if source.column_start < col <= source.column_start + source.column_count:
            raise ValueError("수식 결과 범위가 원본 선택 범위와 겹칩니다.")


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


def find_formula_job(formula_jobs: dict, formula_job_id: UUID) -> FormulaJob:
    formula_job = formula_jobs.get(str(formula_job_id))
    if not isinstance(formula_job, FormulaJob):
        raise NotFoundError("수식 작업이 없습니다. 다시 시작하세요.")
    return formula_job


def public_formula_job(formula_job: FormulaJob) -> dict:
    return {
        "formula_job_id": str(formula_job.source.formula_job_id),
        "conversation_id": str(formula_job.source.conversation_id),
        "task_type": formula_job.task_type,
        "status": formula_job.status,
        "sheet_name": formula_job.source.sheet_name,
        "address": formula_job.source.address,
        "instruction": formula_job.source.instruction,
        "preview": (
            formula_job.preview.model_dump(mode="json") if formula_job.preview else None
        ),
        "clarification": (
            formula_job.preview.plan.clarification if formula_job.preview else None
        ),
        "approved_preview_id": (
            str(formula_job.approved_preview_id) if formula_job.approved_preview_id else None
        ),
        "error": formula_job.error,
        "result": formula_job.result.model_dump(mode="json") if formula_job.result else None,
    }


def formula_job_context(formula_job: FormulaJob) -> dict:
    public = public_formula_job(formula_job)
    return {
        "formula_job_id": public["formula_job_id"],
        "task_type": formula_job.task_type,
        "status": formula_job.status,
        "sheet_name": public["sheet_name"],
        "address": public["address"],
        "instruction": public["instruction"],
        "analysis": formula_job.preview.plan.summary if formula_job.preview else formula_job.error,
        "plan": formula_job.preview.plan.model_dump(mode="json") if formula_job.preview else None,
        "analysis_truncated": False,
    }


async def create_formula_job(payload: CreateFormulaJobRequest, repository, formula_jobs: dict) -> dict:
    cid, key = str(payload.conversation_id), str(payload.formula_job_id)
    async with repository.edit(cid) as conversation:
        existing = formula_jobs.get(key)
        if existing is not None:
            if not isinstance(existing, FormulaJob) or existing.source != payload:
                raise ConflictError("같은 작업 ID에 다른 수식 요청이 전달됐습니다.")
            return public_formula_job(existing)
        if len(formula_jobs) >= 100:
            raise ConflictError("개발용 작업 수 제한에 도달했습니다.")
        previous = formula_jobs.get(conversation.workflow.active_formula_job_id)
        def same_scope(item):
            return (isinstance(item, FormulaJob) and item.source.conversation_id == payload.conversation_id
                    and item.source.worksheet_id == payload.worksheet_id
                    and item.source.workspace_id == payload.workspace_id and item.source.table_id == payload.table_id)
        if not same_scope(previous):
            previous = None
        history = [
            FormulaHistoryEntry(
                instruction=item.source.instruction,
                sheet_name=item.source.sheet_name,
                source_address=item.source.address,
                status=item.status,
                plan=item.preview.plan,
            )
            for item in formula_jobs.values()
            if (
                isinstance(item, FormulaJob)
                and item.preview is not None
                and same_scope(item)
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
                previous.source.instruction if isinstance(previous, FormulaJob) else None
            ),
            previous_sheet_name=(
                previous.source.sheet_name if isinstance(previous, FormulaJob) else None
            ),
            previous_address=(
                previous.source.address if isinstance(previous, FormulaJob) else None
            ),
            previous_status=(
                previous.status if isinstance(previous, FormulaJob) else None
            ),
            previous_plan=(
                previous.preview.plan
                if isinstance(previous, FormulaJob) and previous.preview else None
            ),
            previous_plans=tuple(history),
            recent_conversation=tuple(recent_messages),
        )
        formula_job = FormulaJob(source=payload, planning_context=planning_context)
        formula_jobs[key] = formula_job
        conversation.workflow.active_formula_job_id = key
        conversation.workflow.task_type = payload.workspace_task_type or "formula"
        conversation.workflow.pending_intent = None
        conversation.workflow.phase = "FORMULA_JOB_ATTACHED"
        return public_formula_job(formula_job)


async def plan_formula_job(formula_job_id: UUID, formula_jobs: dict, runtime) -> dict:
    formula_job = find_formula_job(formula_jobs, formula_job_id)
    if formula_job.status == "PLANNING":
        raise ConflictError("이미 수식 계획을 만들고 있습니다.")
    if formula_job.status in {"PREVIEW_READY", "NEEDS_INPUT"}:
        return public_formula_job(formula_job)

    if formula_job.status not in {"CREATED", "FAILED"}:
        raise ConflictError("적용을 시작한 수식은 다시 계획하거나 실행할 수 없습니다.")
    formula_job.status, formula_job.error = "PLANNING", ""
    try:
        source = formula_job.source
        response = await asyncio.wait_for(
            runtime.respond(runtime.formula_prompt, {
                "instruction": source.instruction,
                "context": (
                    formula_job.planning_context.model_dump(mode="json")
                    if formula_job.planning_context else None
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
                    "input_columns": [column.model_dump() for column in source.input_columns],
                },
                "sheet_context": (
                    source.sheet_context.model_dump(mode="json")
                    if source.sheet_context else None
                ),
            }),
            timeout=runtime.settings.llm.timeout_seconds + 10,
        )
        plan = parse_formula_plan(response.content.strip())
        validate_source_reference(plan, source)
        validate_output_scope(plan, source)
        formula_job.preview = FormulaPreview(plan=plan)
        formula_job.approved_preview_id = None
        formula_job.status = "PREVIEW_READY" if plan.actions else "NEEDS_INPUT"
    except asyncio.CancelledError:
        formula_job.status = "FAILED"
        formula_job.error = "수식 계획 생성이 중단됐습니다. 다시 시도하세요."
        raise
    except Exception:
        logger.exception("수식 계획 생성 실패: formula_job_id=%s", formula_job_id)
        formula_job.status = "FAILED"
        formula_job.error = "안전하게 실행할 수식 계획을 만들지 못했습니다. 요청을 구체적으로 다시 작성하세요."
    return public_formula_job(formula_job)


def approve_preview(
    formula_job_id: UUID,
    preview_id: UUID,
    payload: FormulaApprovalRequest | None,
    formula_jobs: dict,
) -> FormulaPreview:
    formula_job = find_formula_job(formula_jobs, formula_job_id)
    if (
        formula_job.status != "PREVIEW_READY"
        or formula_job.preview is None
        or formula_job.preview.preview_id != preview_id
    ):
        raise ConflictError("확인한 수식 계획이 현재 미리보기와 다릅니다.")
    revised = formula_job.preview
    if payload is not None:
        requested_ranges = payload.ranges()
        if len(requested_ranges) != len(formula_job.preview.plan.actions):
            raise ConflictError("결과 열 개수가 수식 계획과 다릅니다.")
        revised_actions = []
        for action, target_range in zip(
            formula_job.preview.plan.actions, requested_ranges, strict=True,
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
        revised = FormulaPreview(
            preview_id=formula_job.preview.preview_id,
            plan=FormulaPlan.model_validate({**formula_job.preview.plan.model_dump(),
                                            "actions": tuple(revised_actions)}),
        )
    validate_output_scope(revised.plan, formula_job.source)
    formula_job.preview = revised
    formula_job.approved_preview_id = preview_id
    formula_job.status = "APPLYING"
    return formula_job.preview


def complete_formula_job(formula_job_id: UUID, preview_id: UUID, payload: FormulaCompletion, formula_jobs: dict) -> dict:
    job = find_formula_job(formula_jobs, formula_job_id)
    if job.approved_preview_id != preview_id or job.preview is None:
        raise ConflictError("승인된 수식 계획만 완료할 수 있습니다.")
    if job.status == "APPLIED":
        if job.result != payload:
            raise ConflictError("이미 기록된 수식 결과와 다릅니다.")
        return public_formula_job(job)
    if job.status != "APPLYING":
        raise ConflictError("적용 중인 수식만 완료할 수 있습니다.")
    if len(payload.targets) != len(job.preview.plan.actions):
        raise ConflictError("실제 결과 열 개수가 승인한 계획과 다릅니다.")
    for target, action in zip(payload.targets, job.preview.plan.actions, strict=True):
        actual = (target.row_start + 1, target.column_start + 1,
                  target.row_start + target.row_count, target.column_start + target.column_count)
        if actual != range_bounds(action.target_range):
            raise ConflictError("실제 수식 결과 범위가 승인한 계획과 다릅니다.")
    ids = payload.result_column_ids
    if (len(set(ids)) != len(ids) or
        (job.source.workspace_id is not None and len(ids) != len(payload.targets)) or
        (job.source.workspace_id is None and ids) or
        set(ids) & {column.column_id for column in job.source.input_columns}):
        raise ConflictError("수식 결과 열 ID가 올바르지 않습니다.")
    job.result = payload
    job.status = "APPLIED"
    return public_formula_job(job)


def mark_formula_unknown(formula_job_id: UUID, preview_id: UUID, formula_jobs: dict) -> dict:
    job = find_formula_job(formula_jobs, formula_job_id)
    if job.approved_preview_id != preview_id or job.status not in {"APPLYING", "UNKNOWN"}:
        raise ConflictError("적용을 시작한 수식만 완료 미확인으로 기록할 수 있습니다.")
    job.status = "UNKNOWN"
    job.error = "수식 적용 완료를 확인하지 못했습니다. 결과 범위를 확인하세요. 자동 재실행하지 않습니다."
    return public_formula_job(job)
