import json
import logging

from typing import Annotated, TypedDict
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pydantic import ValidationError

from agents.request_tools import build_request_tools
from services.errors import MODEL_RESPONSE_ERROR


class RequestState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    failures: int
    decision: dict | None


def clarification(answer: str) -> dict:
    return {
        "intent": "clarify",
        "task_type": None,
        "operation": None,
        "answer": answer,
    }


async def run_request_graph(runtime, messages, task_context: dict) -> dict:
    tools = build_request_tools(task_context)
    tools_by_name = {item.name: item for item in tools}
    model = runtime.model.bind_tools(
        tools,
        tool_choice="required",
        parallel_tool_calls=False,
    )

    async def call_model(state: RequestState):
        reply = await model.ainvoke(state["messages"])

        if not isinstance(reply, AIMessage):
            raise ValueError(MODEL_RESPONSE_ERROR)

        if reply.invalid_tool_calls:
            return {
                "decision": clarification(
                    MODEL_RESPONSE_ERROR
                ),
            }

        if reply.tool_calls:
            return {"messages": [reply]}

        logging.getLogger(__name__).warning(
            "모델 도구 호출 누락: finish_reason=%s, content_length=%s",
            reply.response_metadata.get("finish_reason"), len(reply.content),
        )

        return {
            "decision": clarification(
                MODEL_RESPONSE_ERROR
            ),
        }

    async def run_tool(state: RequestState):
        calls = state["messages"][-1].tool_calls

        if len(calls) != 1:
            return {
                "decision": clarification(
                    MODEL_RESPONSE_ERROR
                ),
            }

        call = calls[0]
        try:
            selected = tools_by_name.get(call["name"])
            if selected is None:
                raise ValueError("제공된 도구 중 하나를 선택하세요.")

            decision = await selected.ainvoke(call["args"])
            return {"decision": decision}

        except (ValidationError, ValueError) as error:
            if state["failures"] >= 1:
                return {
                    "decision": clarification(
                        MODEL_RESPONSE_ERROR
                    ),
                }

            if isinstance(error, ValidationError):
                detail = "; ".join(
                    item["msg"]
                    for item in error.errors(include_input=False)
                )
            else:
                detail = str(error)

            return {
                "failures": state["failures"] + 1,
                "messages": [
                    ToolMessage(
                        content=(
                            f"입력 오류: {detail[:1000]}\n"
                            "사용자 요청에 근거해 수정하거나 "
                            "ask_user로 필요한 정보를 질문하세요."
                        ),
                        tool_call_id=call["id"],
                    ),
                ],
            }

    graph = StateGraph(RequestState)
    graph.add_node("model", call_model)
    graph.add_node("tools", run_tool)
    graph.add_edge(START, "model")
    graph.add_conditional_edges(
        "model",
        lambda state: END if state["decision"] is not None else "tools",
    )
    graph.add_conditional_edges(
        "tools",
        lambda state: END if state["decision"] is not None else "model",
    )

    result = await graph.compile().ainvoke(
        {
            "messages": [
                SystemMessage(content=runtime.tools_prompt),
                HumanMessage(
                    content=json.dumps(
                        {"task_context": task_context},
                        ensure_ascii=False,
                    )
                ),
                *messages,
            ],
            "failures": 0,
            "decision": None,
        },
        config={"recursion_limit": 8},
    )
    return result["decision"]






