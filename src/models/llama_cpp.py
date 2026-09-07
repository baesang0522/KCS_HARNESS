from typing import Any

from langchain_core.messages import AIMessage
from langchain_deepseek import ChatDeepSeek


def create_model(*, base_url: str, model: str, api_key: str="not-needed", temperature: float=0.1,
                 timeout_seconds: float=120, max_tokens: int=2048, max_retries: int=2) -> ChatDeepSeek:
    if not base_url.strip():
        raise ValueError("LLM base_url이 비어 있습니다.")

    if not model.strip():
        raise ValueError("LLM model이 비어 있습니다.")

    extra_body: dict[str, Any] = {
        "reasoning_format": "deepseek",
    }

    return ChatDeepSeek(
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        model=model,
        temperature=temperature,
        timeout=timeout_seconds,
        max_tokens=max_tokens,
        max_retries=max_retries,
        streaming=False,
        extra_body=extra_body,
    )


def get_reasoning_content(message: AIMessage) -> str|None:
    reasoning_content = message.additional_kwargs.get("reasoning_content")

    if not isinstance(reasoning_content, str):
        return None
    reasoning_content = reasoning_content.strip()
    return reasoning_content or None

