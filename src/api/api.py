import logging
from uuid import UUID

from fastapi import HTTPException, Request
from langchain_core.messages import AIMessage, HumanMessage
from starlette import status

from api.schemas import ChatRequest, ChatResponse
from models.llama_cpp import get_reasoning_content
from repositories.memory_conversation_repository import StoredTurn

logger = logging.getLogger(__name__)


async def health() -> dict[str, str]:
    return {"status": "ok"}


def get_conversation(request: Request, conversation_id: str):
    try:
        return request.app.state.conversations.get(conversation_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="대화가 없습니다. 서버 시작 후에는 새 대화를 시작하세요") from None


async def create_conversation(request: Request):
    try:
        conversation_id = request.app.state.conversations.create()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

    return {"conversation_id": conversation_id}


async def read_conversation(conversation_id: UUID, request: Request):
    cid = str(conversation_id)
    get_conversation(request, cid)

    return {"conversation_id": cid, "messages": request.app.state.conversations.list_messages(cid)}


async def chat(payload: ChatRequest, request: Request) -> ChatResponse:
    runtime = request.app.state.runtime
    cid = str(payload.conversation_id)
    rid = str(payload.request_id)
    conversation = get_conversation(request, cid)

    async with conversation.lock:
        for turn in conversation.turns:
            if turn.request_id == rid:
                if turn.question != payload.message:
                    raise HTTPException(status_code=409, detail="같은 요청 ID에 다른 질문이 전달됐습니다.")
                return ChatResponse(
                    conversation_id=cid,
                    request_id=rid,
                    answer=turn.answer,
                    reasoning=turn.reasoning,
                )

        if len(conversation.turns) >= 100:
            raise HTTPException(
                status_code=409,
                detail="개발용 대화 길이 제한입니다. 새 대화를 시작하세요."
            )

        messages = []
        for turn in conversation.turns[-10:]:
            messages.extend([HumanMessage(content=turn.question),
                            AIMessage(content=turn.answer)])

        history_length = len(messages)
        messages.append(HumanMessage(content=payload.message))

        try:
            result = await runtime.graph.ainvoke(
                {
                    "messages": messages,
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
            generated = result["messages"][history_length:]

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
            raise HTTPException(
                status_code=502,
                detail="모델 처리에 실패했습니다. 하네스 로그를 확인하세요.",
            ) from error

            # 모델 호출이 성공한 뒤 질문·답변을 함께 저장한다.
        conversation.turns.append(
            StoredTurn(
                request_id=rid,
                question=payload.message,
                answer=answer,
                reasoning=reasoning,
            )
        )

        return ChatResponse(
            conversation_id=cid,
            request_id=rid,
            answer=answer,
            reasoning=reasoning,
        )
