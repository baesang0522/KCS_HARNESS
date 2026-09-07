from collections.abc import Sequence

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import SystemMessage
from langchain_core.tools import BaseTool

from agents.agent_state import AgentState


class AgentNode:
    def __init__(self, model: BaseChatModel, tools: Sequence[BaseTool], system_prompt: str):
        self.model = model.bind_tools(tools) if tools else model
        self.system_prompt = system_prompt

    async def __call__(self, state: AgentState):
        messages = list(state["messages"])
        if self.system_prompt:
            messages.insert(0, SystemMessage(content=self.system_prompt))
        response = await self.model.ainvoke(messages)
        return {"messages": [response]}
