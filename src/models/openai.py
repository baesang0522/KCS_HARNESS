from langchain_openai import ChatOpenAI


def create_model(*, base_url: str, model: str, api_key: str = "", temperature: float = 0.1,
                 timeout_seconds: float = 120, max_tokens: int = 2048, max_retries: int = 2) -> ChatOpenAI:
    return ChatOpenAI(
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        model=model,
        temperature=temperature,
        timeout=timeout_seconds,
        max_tokens=max_tokens,
        max_retries=max_retries,
        streaming=False,
    )
