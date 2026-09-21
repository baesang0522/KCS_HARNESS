import json
import logging

from langchain_core.messages import AIMessage, HumanMessage

from agents.request_router import route_request
from models.llama_cpp import get_reasoning_content
from repositories.conversation_repository import StoredTurn
from services.chat_state import TaskType, WorkFlowState
from services.errors import ConflictError, ModelProcessingError
from services.jobs.model_normalization.service import job_context
from services.jobs.counterparty_cleanup.service import job_context as counterparty_context
from services.jobs.formula.schemas import Job as FormulaJob
from services.jobs.formula.service import job_context as formula_context

logger = logging.getLogger(__name__)


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

    if str(job.source.conversation_id) != conversation_id:
        raise ValueError("현재 대화와 작업의 연결이 일치하지 않습니다.")

    if isinstance(job, FormulaJob):
        context["active_job"] = formula_context(job)
    elif state.task_type == "counterparty_cleanup":
        context["active_job"] = counterparty_context(job)
    else:
        context["active_job"] = job_context(job)
    return context


def build_followup_messages(messages: list, task_context: dict) -> list:
    # 원본 대화 목록은 변경하지 않는다.
    # 마지막 사용자 질문 바로 앞에 현재 작업 데이터를 넣는다.
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


async def process_chat(*, runtime, repository, jobs: dict,
                       conversation_id: str, request_id: str, message: str) -> dict:
    cid = conversation_id
    rid = request_id
    # ponytail: 대화별 잠금은 LLM 응답까지 유지한다. 병렬 처리가 필요하면 요청 예약·버전 검증으로 전환.
    async with repository.edit(cid) as conversation:
        for turn in conversation.turns:
            if turn.request_id == rid:
                if turn.question != message:
                    raise ConflictError("같은 요청 ID에 다른 질문이 전달됐습니다.")
                return dict(
                    conversation_id=cid,
                    request_id=rid,
                    answer=turn.answer,
                    reasoning=turn.reasoning,
                    ui_action=turn.ui_action,
                )

        if len(conversation.turns) >= 100:
            raise ConflictError("개발용 대화 길이 제한입니다. 새 대화를 시작하세요.")

        messages = []
        for turn in conversation.turns[-10:]:
            messages.extend([
                HumanMessage(content=turn.question),
                AIMessage(content=turn.answer),
            ])

        messages.append(HumanMessage(content=message))

        try:
            task_context = build_task_context(
                conversation.workflow,
                jobs,
                conversation_id=cid,
            )
            decision = await route_request(
                runtime=runtime,
                messages=messages,
                request_id=rid,
                task_context=task_context,
            )

            if decision.intent in {"start_task", "clarify"}:
                action = None

                if decision.intent == "start_task":
                    action = dict(
                        type="confirm_selection",
                        task_type=decision.task_type,
                    )

                await conversation.save_turn(
                    StoredTurn(
                        request_id=rid,
                        question=message,
                        answer=decision.answer,
                        reasoning=[],
                        ui_action=action,
                    )
                )
                apply_request_decision(
                    conversation.workflow,
                    intent=decision.intent,
                    task_type=decision.task_type,
                    message=message,
                )
                return dict(
                    conversation_id=cid,
                    request_id=rid,
                    answer=decision.answer,
                    reasoning=[],
                    ui_action=action,
                )

            answer_messages = messages
            if decision.intent == "task_followup":
                answer_messages = build_followup_messages(
                    messages,
                    task_context,
                )

            result = await runtime.chat_graph.ainvoke(
                {
                    "messages": answer_messages,
                    "request_id": rid,
                    "tool_history": [],
                },
                config={
                    "recursion_limit": (
                            runtime.settings.agent.max_iterations * 2 + 2
                    ),
                },
            )

            # 이전 답변이 아니라 이번 실행에서 생성된 답변만 확인한다.
            generated = result["messages"][len(answer_messages):]

            ai_messages = [
                item for item in generated
                if isinstance(item, AIMessage)
            ]

            if not ai_messages:
                raise RuntimeError("모델이 답변을 생성하지 않았습니다.")

            last_message = ai_messages[-1]

            if last_message.tool_calls:
                raise RuntimeError("도구 호출 후 최종 답변이 완료되지 않았습니다.")

            if not isinstance(last_message.content, str):
                raise RuntimeError("현재 채팅은 텍스트 답변만 지원합니다.")

            answer = last_message.content.strip()

            if not answer:
                raise RuntimeError("모델 답변이 비어 있습니다.")

            reasoning = [
                text
                for item in ai_messages
                if (text := get_reasoning_content(item))
            ]

        except Exception as error:
            logger.exception(
                "채팅 처리 실패: conversation_id=%s request_id=%s",
                cid,
                rid,
            )
            raise ModelProcessingError("모델 처리에 실패했습니다. 하네스 로그를 확인하세요.") from error

        action = None
        if decision.intent == "task_followup" and decision.policy_change:
            action = {
                "type": "review_counterparty_policy",
                "instruction": message,
            }

        # 모델 호출이 성공한 뒤 질문·답변을 함께 저장한다.
        await conversation.save_turn(
            StoredTurn(
                request_id=rid,
                question=message,
                answer=answer,
                reasoning=reasoning,
                ui_action=action,
            )
        )

        return dict(
            conversation_id=cid,
            request_id=rid,
            answer=answer,
            reasoning=reasoning,
            ui_action=action,
        )
