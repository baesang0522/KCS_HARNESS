from dataclasses import dataclass
import json
import re
from pathlib import Path

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from models.openai import create_model as create_openai_model
from models.llama_cpp import create_model as create_internal_model
from models.codex_adapter import CodexModel
from prompts.loader import load_agent_prompt
from settings import Settings, load_settings


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

@dataclass(frozen=True)
class CustomsHarness:
    settings: Settings
    model: BaseChatModel | CodexModel
    formula_prompt: str
    tools_prompt: str
    recommendation_prompt: str
    advice_model: BaseChatModel | CodexModel | None = None

    async def respond(self, prompt: str, payload: dict) -> AIMessage:
        response = await self.model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
        ])
        if (not isinstance(response, AIMessage) or response.tool_calls
                or not isinstance(response.content, str) or not response.content.strip()):
            raise ValueError("모델이 유효한 답변을 반환하지 않았습니다.")
        # JSON 전체를 감싼 코드 블록만 벗긴다. 내용 검증은 각 호출부에서 유지한다.
        fenced = re.fullmatch(
            r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```",
            response.content.strip(), re.DOTALL | re.IGNORECASE,
        )
        if fenced:
            response = response.model_copy(update={"content": fenced[1].strip()})
        return response


def create_runtime() -> CustomsHarness:
    settings = load_settings()
    llm = settings.llm

    if settings.llm.provider == "codex_cli":
        model = CodexModel(
            model=settings.llm.model,
            timeout_seconds=settings.llm.timeout_seconds,
        )
        advice_model = model
    else:
        common = {
            "base_url": llm.base_url,
            "model": llm.model,
            "api_key": llm.api_key,
            "temperature": llm.temperature,
            "max_retries": llm.max_retries,
        }

        normal_extra = None
        advice_extra = None

        if settings.environment in {"internal", "external"}:
            normal_extra = {
                "reasoning_format": "deepseek",
                "chat_template_kwargs": {"enable_thinking": False},
            }
            advice_extra = {
                "reasoning_format": "deepseek",
                "chat_template_kwargs": {"enable_thinking": False},
            }

        # 내부망과 로컬 llama.cpp는 같은 요청 옵션과 응답 어댑터를 사용한다.
        create_model = create_internal_model if settings.environment in {"internal", "external"} else create_openai_model
        model = create_model(
            **common,
            timeout_seconds=llm.timeout_seconds,
            max_tokens=llm.max_tokens,
            extra_body=normal_extra,
        )
        advice_model = create_model(
            **common,
            timeout_seconds=300,
            max_tokens=llm.advice_max_tokens,
            extra_body=advice_extra,
        )

    return CustomsHarness(
        settings=settings,
        model=model,
        advice_model=advice_model,
        formula_prompt=load_agent_prompt(PROMPT_DIR / "formula.yml").render(),
        tools_prompt=load_agent_prompt(PROMPT_DIR / "request_tools.yml").render(),
        recommendation_prompt=load_agent_prompt(PROMPT_DIR / "recommendation.yml").render(),
    )
