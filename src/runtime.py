from dataclasses import dataclass
import json
from pathlib import Path

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from models.llama_cpp import create_model
from models.openai import create_model as create_openai_model
from models.codex_adapter import CodexModel
from prompts.loader import load_agent_prompt
from settings import Settings, load_settings


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

@dataclass(frozen=True)
class CustomsHarness:
    settings: Settings
    model: BaseChatModel | CodexModel
    request_prompt: str
    formula_prompt: str

    async def respond(self, prompt: str, payload: dict) -> AIMessage:
        response = await self.model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
        ])
        if (not isinstance(response, AIMessage) or response.tool_calls
                or not isinstance(response.content, str) or not response.content.strip()):
            raise ValueError("모델이 유효한 답변을 반환하지 않았습니다.")
        return response


def create_runtime() -> CustomsHarness:
    settings = load_settings()

    if settings.llm.provider == "codex_cli":
        model = CodexModel(
            model=settings.llm.model,
            timeout_seconds=settings.llm.timeout_seconds,
        )

    else:
        model_factory = (
            create_openai_model
            if settings.environment == "external-sj"
            else create_model
        )

        model = model_factory(
            base_url=settings.llm.base_url,
            model=settings.llm.model,
            api_key=settings.llm.api_key,
            temperature=settings.llm.temperature,
            timeout_seconds=settings.llm.timeout_seconds,
            max_tokens=settings.llm.max_tokens,
            max_retries=settings.llm.max_retries,
        )

    return CustomsHarness(
        settings=settings,
        model=model,
        request_prompt=load_agent_prompt(PROMPT_DIR / "request_router.yml").render(),
        formula_prompt=load_agent_prompt(PROMPT_DIR / "formula.yml").render(),
    )
