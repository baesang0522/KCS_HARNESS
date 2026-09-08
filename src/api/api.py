from uuid import uuid4

from fastapi import Request
from langchain_core.messages import AIMessage, HumanMessage

from schemas import ChatRequest, ChatResponse
from models.llama_cpp import get_reasoning_content
from runtime import CustomsHarness


async def health() -> dict[str, str]:
    return {"status": "ok"}


async def chat(payload: ChatRequest, request: Request) -> ChatResponse:
    runtime: CustomsHarness = request.app.state.runtime()
    request_id = str(uuid4())

    result = await runtime.graph.ainvoke(
        {
            "messages": [
                HumanMessage(content=payload.message),
            ],
            "request_id": request_id,
            "tool_history": [],
        },
        config={
            "recursion_limit": (
                runtime.settings.agent.max_iterations * 2 + 2
            ),
        },
    )
    ai_message = [message for message in result["messages"] if isinstance(message, AIMessage)]

    if not ai_message:
        raise RuntimeError(
            "Agent가 응답 메세지를 생성하지 않았습니다."
        )

    last_message = ai_message[-1]
    reasoning = [reasoning_content for message in ai_message if (reasoning_content := get_reasoning_content(message))]

    return ChatResponse(request_id=request_id, answer=str(last_message.content), reasoning=reasoning)

