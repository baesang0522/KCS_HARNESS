import json

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
            raise ValueError("모델 응답 형식이 올바르지 않습니다.")

        if reply.invalid_tool_calls:
            return {
                "decision": clarification(
                    "작업 설정을 올바르게 만들지 못했습니다. "
                    "대상 열과 처리 조건을 확인해 주세요."
                ),
            }

        if reply.tool_calls:
            return {"messages": [reply]}

        print(
            f"모델 tool 호출 누락: "
            f"content={reply.content!r} "
            f"additional_kwargs={reply.additional_kwargs!r} "
            f"response_metatdata={reply.response_metadata!r} "
        )

        return {
            "decision": clarification(
                "도구 호출이 없어 작업 설정을 확인할 수 없습니다. "
                "아직 셀은 수정하지 않았습니다. "
                "요청을 다시 보내거나 작업 카드에서 직접 설정해 주세요."
            ),
        }

    async def run_tool(state: RequestState):
        calls = state["messages"][-1].tool_calls

        if len(calls) != 1:
            return {
                "decision": clarification(
                    "여러 작업이 한꺼번에 선택됐습니다. "
                    "먼저 처리할 작업 하나를 알려주세요."
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
                        "작업 설정을 확정하지 못했습니다. "
                        "대상 열과 제거할 단어·치환 조건을 구체적으로 알려주세요."
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






