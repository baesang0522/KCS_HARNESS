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
from tools.registry import get_local_tools
from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

@dataclass(frozen=True)
class CustomsHarness:
    settings: Settings
    chat_graph: CompiledStateGraph
    inspection_graph: CompiledStateGraph
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

    tools = get_local_tools(
        workspace_root=settings.workspace.root_path,
    )

    def build_graph(
        prompt_name: str,
        tools: Sequence[BaseTool] = (),
    ) -> CompiledStateGraph:
        return build_harness_graph(
            agent_node=AgentNode(
                model=model,
                tools=tools,
                system_prompt=load_agent_prompt(
                    PROMPT_DIR / prompt_name
                ).render(),
            ),
            tools=tools,
        )

    chat_graph = build_graph("chat.yml")
    inspection_graph = build_graph("inspection.yml")
    request_router_graph = build_graph("request_router.yml")

    return CustomsHarness(
        settings=settings,
        chat_graph=chat_graph,
        inspection_graph=inspection_graph,
        request_router_graph=request_router_graph,
    )
