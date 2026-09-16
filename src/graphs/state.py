import operator
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from langgraph.graph import MessagesState


class ToolHistoryEntry(TypedDict):
    """Harness가 기록할 도구 호출 한 건."""

    name: str
    source: Literal["local", "mcp"]
    arguments: dict[str, Any]
    success: bool
    result: NotRequired[Any]
    error: NotRequired[str]


class AgentState(MessagesState):
    """LangGraph 에이전트가 노드 사이에서 공유하는 상태."""

    request_id: NotRequired[str]
    tool_history: Annotated[list[ToolHistoryEntry], operator.add]
