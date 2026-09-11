from dataclasses import dataclass

from langgraph.graph.state import CompiledStateGraph

from agents.agent import AgentNode
from graphs.harness_graph import build_harness_graph
from models.llama_cpp import create_model
from models.codex_adapter import CodexModel
from prompts.loader import load_agent_prompt
from settings import Settings, load_settings
from tools.registry import get_local_tools


@dataclass(frozen=True)
class CustomsHarness:
    settings: Settings
    graph: CompiledStateGraph


def create_runtime() -> CustomsHarness:
    settings = load_settings()

    if settings.llm.provider == "codex_cli":
        model = CodexModel(
            timeout_seconds=settings.llm.timeout_seconds,
        )

    else:
        model = create_model(
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

    agent_prompt = load_agent_prompt()
    agent_node = AgentNode(
        model=model,
        tools=tools,
        system_prompt=agent_prompt.render(),
    )

    graph = build_harness_graph(
        agent_node=agent_node,
        tools=tools,
    )

    return CustomsHarness(settings=settings, graph=graph)
