import logging

from langchain_core.messages import AIMessage, HumanMessage

from agents.request_router import route_request
from repositories.conversation_repository import StoredTurn
from services.errors import ConflictError, ModelProcessingError
from services.formula.service import job_context

logger = logging.getLogger(__name__)


def workflow_snapshot(state, jobs: dict) -> dict:
    job = jobs.get(state.active_job_id)
    return {"pending_intent": state.pending_intent,
            "active_job_id": state.active_job_id,
            "task_type": state.task_type,
            "phase": state.phase,
            "job_status": job.status if job else None}


def build_task_context(state, jobs: dict, *,
                       conversation_id: str, workspace=None) -> dict:
    job = jobs.get(state.active_job_id)
    if job and str(job.source.conversation_id) != conversation_id:
        raise ValueError("현재 대화와 작업의 연결이 일치하지 않습니다.")

    return {"pending_intent": state.pending_intent,
            "task_type": workspace["task_type"] if workspace else state.task_type,
            "phase": state.phase, "workspace": workspace,
            "active_job": job_context(job) if job else None}


async def process_chat(*, runtime, repository, jobs: dict, conversation_id: str,
                       request_id: str, message: str, workspace=None) -> dict:
    async with repository.edit(conversation_id) as conversation:
        for turn in conversation.turns:
            if turn.request_id == request_id:
                if turn.question != message or turn.request_context != workspace:
                    raise ConflictError("같은 요청 ID에 다른 질문 또는 작업 대상이 전달됐습니다.")

                return dict(conversation_id=conversation_id, request_id=request_id,
                            answer=turn.answer, reasoning=turn.reasoning, ui_action=turn.ui_action)

        if len(conversation.turns) >= 100:
            raise ConflictError("개발용 대화 길이 제한입니다. 새 대화를 시작하세요.")

        messages = []
        for turn in conversation.turns[-10:]:
            messages.extend([HumanMessage(content=turn.question), AIMessage(content=turn.answer)])

        messages.append(HumanMessage(content=message))
        state = conversation.workflow
        action, reasoning = None, []
        try:
            context = build_task_context(state, jobs, conversation_id=conversation_id, workspace=workspace)
            decision, reasoning = await route_request(runtime, messages, task_context=context)
            answer = decision.answer
            if decision.intent == "start_task":
                action = {"type": "confirm_selection", "task_type": decision.task_type}
            elif decision.intent == "operation":
                action = {"type": "configure_operation", "operation": decision.operation.model_dump()}
        except Exception as error:
            logger.exception("채팅 처리 실패: conversation_id=%s", conversation_id)
            raise ModelProcessingError("요청을 해석하지 못했습니다. 대상과 조건을 구체적으로 알려주세요.") from error

        await conversation.save_turn(StoredTurn(
            request_id=request_id, question=message, answer=answer, reasoning=reasoning,
            ui_action=action, request_context=workspace,
        ))
        if decision.intent == "start_task":
            state.task_type, state.pending_intent, state.phase = decision.task_type, None, "WAITING_SELECTION"

        elif decision.intent == "clarify" and not workspace:
            state.pending_intent = state.pending_intent or message
            state.phase = "WAITING_TASK_TYPE"

        return dict(conversation_id=conversation_id, request_id=request_id,
                    answer=answer, reasoning=reasoning, ui_action=action)
