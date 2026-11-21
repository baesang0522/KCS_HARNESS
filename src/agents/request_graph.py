from services.workspace import summarize_row_scopes
import json
from time import perf_counter
from uuid import uuid4

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
from services.errors import RepeatedReadError
from services.debug_log import log_event


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


async def run_request_graph(runtime, messages, task_context: dict, *, log_context=None) -> dict:
    ids = {**(log_context or {}), "graph_id": str(uuid4())}
    tools = build_request_tools(task_context)
    prompt = runtime.tools_prompt
    if task_context.get("agent_execution"):
        from pathlib import Path
        from prompts.loader import load_agent_prompt
        from agents.execution_tools import execution_tools
        prompt = load_agent_prompt(Path(__file__).resolve().parents[1] / "prompts/execution.yml").render()
        if task_context.get("agent_run", {}).get("code_grouping_request"):
            prompt += "\n\n" + load_agent_prompt(Path(__file__).resolve().parents[1] / "prompts/code_grouping.yml").render()
        tools = execution_tools(task_context, tools)
    model_context = summarize_row_scopes(task_context)
    tools_by_name = {item.name: item for item in tools}
    model = runtime.model.bind_tools(
        tools,
        tool_choice="required",
        parallel_tool_calls=False,
    )

    async def call_model(state: RequestState):
        started = perf_counter()
        log_event("model.started", **ids, attempt=state["failures"] + 1,
                  task_context=model_context,
                  messages=[{"role": message.type, "content": message.content}
                            for message in state["messages"][2:]],
                  tools=list(tools_by_name))
        try:
            reply = await model.ainvoke(state["messages"])
            if not isinstance(reply, AIMessage):
                raise ValueError(MODEL_RESPONSE_ERROR)
        except Exception as error:
            log_event("model.failed", level="ERROR", **ids,
                      error_type=type(error).__name__, error_message=str(error),
                      elapsed_ms=round((perf_counter() - started) * 1000))
            raise
        log_event("model.completed", **ids, tool_calls=reply.tool_calls,
                  invalid_tool_calls=reply.invalid_tool_calls,
                  finish_reason=reply.response_metadata.get("finish_reason"),
                  elapsed_ms=round((perf_counter() - started) * 1000))

        if reply.invalid_tool_calls:
            log_event("model.invalid_tool_calls", level="WARNING", **ids,
                      invalid_tool_calls=reply.invalid_tool_calls)
            return {
                "decision": clarification(
                    MODEL_RESPONSE_ERROR
                ),
            }

        if reply.tool_calls:
            return {"messages": [reply]}

        log_event("model.missing_tool_call", level="WARNING", **ids,
                  finish_reason=reply.response_metadata.get("finish_reason"), content=reply.content)

        return {
            "decision": clarification(
                MODEL_RESPONSE_ERROR
            ),
        }

    async def run_tool(state: RequestState):
        calls = state["messages"][-1].tool_calls

        if len(calls) != 1:
            log_event("tool.rejected", level="WARNING", **ids, tool_calls=calls,
                      reason="한 번에 하나의 도구만 호출할 수 있습니다.")
            return {
                "decision": clarification(
                    MODEL_RESPONSE_ERROR
                ),
            }

        call = calls[0]
        tool_ids = {**ids, "tool_call_id": call["id"], "tool_name": call["name"],
                    "attempt": state["failures"] + 1}
        started = perf_counter()
        log_event("tool.started", **tool_ids, arguments=call["args"])
        try:
            selected = tools_by_name.get(call["name"])
            if selected is None:
                raise ValueError("제공된 도구 중 하나를 선택하세요.")

            decision = await selected.ainvoke(call["args"])
            log_event("tool.completed", **tool_ids, result=decision,
                      elapsed_ms=round((perf_counter() - started) * 1000))
            return {"decision": decision}

        except (ValidationError, ValueError) as error:
            log_event("tool.failed", level="WARNING", **tool_ids,
                      error_type=type(error).__name__,
                      error_message=(error.errors(include_input=False, include_context=False)
                                     if isinstance(error, ValidationError) else str(error)),
                      will_retry=state["failures"] < 1,
                      elapsed_ms=round((perf_counter() - started) * 1000))
            if state["failures"] >= 1:
                if isinstance(error, RepeatedReadError):
                    raise
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

        except Exception as error:
            log_event("tool.failed", level="ERROR", **tool_ids,
                      error_type=type(error).__name__, error_message=str(error), will_retry=False,
                      elapsed_ms=round((perf_counter() - started) * 1000))
            raise

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
                SystemMessage(content=prompt),
                HumanMessage(
                    content=json.dumps(
                        {"task_context": model_context},
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






