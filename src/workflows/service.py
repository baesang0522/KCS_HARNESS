import json

from langchain_core.messages import HumanMessage

from workflows.state import TaskType, WorkFlowState


def apply_request_decision(
        state: WorkFlowState,
        *,
        intent: str,
        task_type: TaskType | None,
        message: str,
) -> None:
    # 이미 연결된 작업을 분류 결과만으로 덮어쓰지 않는다.
    # 작업 전환과 수정 의견 처리는 다음 단계에서 추가한다.
    if state.active_job_id is not None:
        return

    if intent == "clarify":
        if state.pending_intent is None:
            state.pending_intent = message

        state.phase = "WAITING_TASK_TYPE"

    elif intent == "start_task":
        state.task_type = task_type
        state.pending_intent = None
        state.phase = "WAITING_SELECTION"


def attach_model_job(
        state: WorkFlowState,
        job_id: str,
) -> None:
    state.active_job_id = job_id
    state.task_type = "model_normalization"
    state.pending_intent = None
    state.phase = "JOB_ATTACHED"


def workflow_snapshot(
        state: WorkFlowState,
        jobs: dict,
) -> dict:
    job = (
        jobs.get(state.active_job_id) if state.active_job_id else None
    )
    return {
        "pending_intent": state.pending_intent,
        "active_job_id": state.active_job_id,
        "task_type": state.task_type,
        "phase": state.phase,
        "job_status": job.status if job is not None else None,
    }


def build_task_context(
    state: WorkFlowState,
    jobs: dict,
    *,
    conversation_id: str,
) -> dict:
    context = {
        "pending_intent": state.pending_intent,
        "task_type": state.task_type,
        "phase": state.phase,
        "active_job": None,
        "job_missing": False,
    }

    if state.active_job_id is None:
        return context

    job = jobs.get(state.active_job_id)

    if job is None:
        context["job_missing"] = True
        return context

    source = job.source

    # 다른 대화에 속한 작업을 문맥으로 사용하지 않는다.
    if str(source.conversation_id) != conversation_id:
        raise ValueError("현재 대화와 작업의 연결이 일치하지 않습니다.")

    mapping = source.mapping
    analysis = job.analysis or ""

    context["active_job"] = {
        "job_id": str(source.job_id),
        "task_type": state.task_type,
        "status": job.status,
        "sheet_name": source.sheet_name,
        "address": source.address,
        "data_row_count": source.row_count - 1,
        "headers": list(source.headers),
        "column_mapping": {
            "trade_name": mapping.trade_name,
            "declared_name": mapping.declared_name,
            "model_spec": mapping.model_spec,
        },
        "sampling": "선택 범위의 머리글 다음 최대 20행",
        "samples": [
            {
                "excel_row": source.row_start + index + 2,
                "거래품명": row.cells[mapping.trade_name],
                "신고품명": row.cells[mapping.declared_name],
                "모델규격": row.cells[mapping.model_spec],
            }
            for index, row in enumerate(source.samples)
        ],
        "analysis": analysis[:12000],
        "analysis_truncated": len(analysis) > 12000,
        "error": job.error,
    }

    return context


def build_followup_messages(messages: list, task_context: dict) -> list:
    # 원본 대화 목록은 변경하지 않는다.
    # 마지막 사용자 질문 바로 앞에 현재 작업 데이터를 넣는다. -> 이건 나중에 수정필요
    context_message = HumanMessage(
        content=json.dumps(
            {"task_context": task_context},
            ensure_ascii=False,
        )
    )

    return [
        *messages[:-1],
        context_message,
        messages[-1],
    ]

