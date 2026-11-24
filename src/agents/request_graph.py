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
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_core.tools import BaseTool
from pydantic import ValidationError

from agents.request_tools import build_request_tools
from agents.review_target import check_review_tool, ReviewTargetError
from services.errors import MODEL_RESPONSE_ERROR
from services.errors import RepeatedReadError
from services.debug_log import log_event
from services.investigation.model_context import model_task_context
from agents.tools.pdf_lookup import build_pdf_lookup_tools


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


def resolve_named_output(arguments, task_context):
    """기존 열의 정확한 이름만 전달된 경우 현재 작업표의 유일한 ID로 연결한다."""
    output = arguments.get("output")
    if isinstance(output, str):
        try:
            output = json.loads(output)
        except ValueError:
            return arguments
    if not isinstance(output, dict) or output.get("mode") != "existing" or output.get("column_id"):
        return arguments
    name = output.get("name")
    matches = [column for column in (task_context.get("workspace") or {}).get("columns", [])
               if name and column.get("header") == name]
    if len(matches) != 1:
        return arguments
    return {**arguments, "output": {**output, "column_id": matches[0]["column_id"]}}


def normalize_column_ids(arguments, task_context):
    """모델이 숫자로 보낸 ID만 현재 작업표의 동일한 문자열 ID로 보정한다."""
    known = {column["column_id"] for column in
             (task_context.get("workspace") or {}).get("columns", [])}

    def identifier(value):
        # bool/float, 열 순번, 앞자리 0을 생략한 ID는 추측하지 않는다.
        return str(value) if type(value) is int and str(value) in known else value

    def fields(value):
        if not isinstance(value, dict):
            return value
        result = {}
        for key, item in value.items():
            if key == "column_id" or key.endswith("_column_id"):
                result[key] = identifier(item)
            elif (key == "column_ids" or key.endswith("_column_ids")) and isinstance(item, list):
                result[key] = [identifier(entry) for entry in item]
            elif key in {"output", "condition", "similarity"}:
                result[key] = fields(item)
            else:
                # 조건값·부호·그룹명·사용자 매핑 등 업무 데이터는 변환하지 않는다.
                result[key] = item
        return result

    return fields(arguments)


async def run_request_graph(runtime, messages, task_context: dict, *, log_context=None, pdf_documents=None) -> dict:
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
    lookup_tools = build_pdf_lookup_tools(task_context, pdf_documents)
    tools += lookup_tools
    lookup_names = {item.name for item in lookup_tools}
    model_context = summarize_row_scopes(model_task_context(task_context))
    tools_by_name = {item.name: item for item in tools}
    tool_schema_chars = sum(len(json.dumps(convert_to_openai_tool(item), ensure_ascii=False))
                            for item in tools if isinstance(item, BaseTool))
    model = runtime.model.bind_tools(
        tools,
        tool_choice="required",
        parallel_tool_calls=False,
    )

    async def call_model(state: RequestState):
        started = perf_counter()
        def size(value):
            return len(json.dumps(value, ensure_ascii=False, default=str))
        log_event('model.input_size', **ids,
                  system_chars=len(prompt),
                  context_chars=size(model_context),
                  context_section_chars={key: size(value) for key, value in model_context.items()},
                  message_chars=[{'role': item.type, 'chars': len(item.content) if isinstance(item.content, str) else size(item.content)}
                                 for item in state['messages']], tool_count=len(tools), tool_schema_chars=tool_schema_chars)
        log_event("model.started", **ids, attempt=state["failures"] + 1,
                  task_context=model_context,
                  messages=[{"role": message.type, **({'content_chars': size(message.content)}
                            if task_context.get('_pdf_read_refs') else {'content': message.content})}
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

            check_review_tool(task_context, call["name"], call["args"])
            arguments = normalize_column_ids(resolve_named_output(call["args"], task_context), task_context)
            if arguments != call["args"]:
                log_event("tool.arguments_normalized", **tool_ids, arguments=arguments)
            decision = await selected.ainvoke(arguments)
            lookup = call['name'] in lookup_names
            log_event("tool.completed", **tool_ids,
                      result=({'lookup': call['name'], 'result_chars': len(json.dumps(decision, ensure_ascii=False))}
                              if lookup else decision),
                      elapsed_ms=round((perf_counter() - started) * 1000))
            if lookup:
                return {'messages': [ToolMessage(content=json.dumps(decision, ensure_ascii=False), tool_call_id=call['id'])]}
            return {"decision": decision}

        except (ValidationError, ValueError) as error:
            log_event("tool.failed", level="WARNING", **tool_ids,
                      error_type=type(error).__name__,
                      error_message=(error.errors(include_input=False, include_context=False)
                                     if isinstance(error, ValidationError) else str(error)),
                      will_retry=state["failures"] < 1,
                      elapsed_ms=round((perf_counter() - started) * 1000))
            if state["failures"] >= 1:
                if isinstance(error, ValidationError) and any(
                    isinstance(part, str) and (part in {"column_id", "column_ids"} or
                        part.endswith("_column_id") or part.endswith("_column_ids"))
                    for item in error.errors(include_input=False) for part in item["loc"]
                ):
                    return {"decision": clarification("AI가 현재 작업표의 열 식별자를 올바른 형식으로 지정하지 못해 이번 단계를 진행하지 못했어. 이번 단계에서는 셀을 변경하지 않았어.")}
                if isinstance(error, ValidationError) and any("output" in item["loc"] for item in error.errors(include_input=False)):
                    return {"decision": clarification("결과 저장 위치 설정의 형식이 잘못되어 작업을 시작하지 못했어. 셀은 변경하지 않았어.")}
                if isinstance(error, RepeatedReadError):
                    raise
                if isinstance(error, ReviewTargetError):
                    return {"decision": clarification(error.answer)}
                return {
                    "decision": clarification(
                        MODEL_RESPONSE_ERROR
                    ),
                }

            if isinstance(error, ValidationError):
                detail = "; ".join(
                    ".".join(map(str, item["loc"])) + ": " + item["msg"]
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






