from typing import Sequence

from langchain_core.tools import BaseTool
from langgraph.constants import START, END
from langgraph.graph.state import CompiledStateGraph, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from agents.agent_state import AgentState, ToolHistoryEntry
from agents.agent import AgentNode


def build_harness_graph(agent_node: AgentNode, tools: Sequence[BaseTool]) -> CompiledStateGraph:
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_edge(START, "agent")

    if tools:
        graph.add_node("tools", ToolNode(tools))
        graph.add_conditional_edges("agent", tools_condition)
        graph.add_edge("tools", "agent")

    else:
        graph.add_edge("agent", END)

    return graph.compile()
