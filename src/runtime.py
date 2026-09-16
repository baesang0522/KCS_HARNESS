from dataclasses import dataclass
from collections.abc import Sequence

from langgraph.graph.state import CompiledStateGraph
from langchain_core.tools import BaseTool

from agents.agent import AgentNode
from graphs.harness_graph import build_harness_graph
from models.llama_cpp import create_model
from models.openai import create_model as create_openai_model
from models.codex_adapter import CodexModel
from prompts.loader import load_agent_prompt
from settings import Settings, load_settings
from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

@dataclass(frozen=True)
class CustomsHarness:
    settings: Settings
    chat_graph: CompiledStateGraph
    inspection_graph: CompiledStateGraph
    counterparty_review_graph: CompiledStateGraph
    request_router_graph: CompiledStateGraph


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

    chat_prompt = load_agent_prompt(PROMPT_DIR / "chat.yml")
    chat_node = AgentNode(
        model=model,
        tools=[],
        system_prompt=chat_prompt.render(),
    )
    chat_graph = build_harness_graph(
        agent_node=chat_node,
        tools=[],
    )

    inspection_prompt = load_agent_prompt(PROMPT_DIR / "inspection.yml")
    inspection_node = AgentNode(
        model=model,
        tools=[],
        system_prompt=inspection_prompt.render(),
    )

    inspection_graph = build_harness_graph(
        agent_node=inspection_node,
        tools=[],
    )

    counterparty_prompt = load_agent_prompt(PROMPT_DIR / "counterparty_review.yml")
    counterparty_review_graph = build_harness_graph(
        agent_node=AgentNode(
            model=model, tools=[], system_prompt=counterparty_prompt.render(),
        ),
        tools=[],
    )

    router_prompt = load_agent_prompt(PROMPT_DIR / "request_router.yml")
    request_router_graph = build_harness_graph(
        agent_node=AgentNode(
            model=model,
            tools=[],
            system_prompt=router_prompt.render(),
        ),
        tools=[]
    )

    return CustomsHarness(
        settings=settings,
        chat_graph=chat_graph,
        inspection_graph=inspection_graph,
        counterparty_review_graph=counterparty_review_graph,
        request_router_graph=request_router_graph,
    )
