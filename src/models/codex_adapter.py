import asyncio
import json
import tempfile
from copy import copy
from pathlib import Path
from uuid import uuid4

from langchain_core.messages import AIMessage


# 도구 인자는 JSON 문자열로 받고, 아래에서 dict로 변환·검증합니다.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "tool_calls": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "arguments_json": {"type": "string"},
                },
                "required": ["name", "arguments_json"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["answer", "tool_calls"],
    "additionalProperties": False,
}


class CodexModel:
    def __init__(self, timeout_seconds: float = 120):
        self.timeout_seconds = timeout_seconds
        self.tools = {}

    def bind_tools(self, tools):
        bound = copy(self)
        bound.tools = {tool.name: tool for tool in tools}
        return bound

    async def ainvoke(self, messages, **kwargs) -> AIMessage:
        tool_specs = [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.get_input_schema().model_json_schema(),
            }
            for tool in self.tools.values()
        ]

        # AIMessage의 도구 요청과 ToolMessage의 실행 결과도 함께 전달합니다.
        conversation = []
        for message in messages:
            item = {
                "role": message.type,
                "content": message.content,
            }

            if isinstance(message, AIMessage):
                item["tool_calls"] = message.tool_calls

            tool_call_id = getattr(message, "tool_call_id", None)
            if tool_call_id is not None:
                item["tool_call_id"] = tool_call_id

            conversation.append(item)

        instruction = """
            너는 외부 LangGraph가 호출하는 모델 역할이다.
            아래 conversation의 system 메시지와 대화 흐름에 따라 응답하라.
            
            도구가 필요하면 available_tools에서 선택하고,
            tool_calls에 도구 이름과 arguments_json을 반환하라.
            arguments_json은 해당 도구 입력 스키마를 따르는 JSON 객체 문자열이다.
            실제 도구 실행은 외부 LangGraph가 담당한다.
            Codex 자체 도구나 셸을 사용해 작업을 대신 수행하지 마라.
            
            도구 호출이 필요한 턴에서는 answer를 빈 문자열로 반환하라.
            최종 답변을 할 때는 answer에 한국어 답변을 쓰고 tool_calls는 빈 배열로 반환하라.
            도구 실행 결과는 conversation의 tool 메시지로 제공된다.
            """

        prompt = instruction + "\n" + json.dumps(
            {
                "available_tools": tool_specs,
                "conversation": conversation,
            },
            ensure_ascii=False,
        )

        # 요청마다 독립된 임시 폴더를 사용합니다.
        with tempfile.TemporaryDirectory(prefix="kcs-codex-") as directory:
            workdir = Path(directory)
            schema_path = workdir / "schema.json"
            output_path = workdir / "answer.json"

            schema_path.write_text(
                json.dumps(OUTPUT_SCHEMA),
                encoding="utf-8",
            )

            process = await asyncio.create_subprocess_exec(
                "codex",
                "exec",
                "--model", "gpt-5.6-luna",
                "--skip-git-repo-check",
                "--sandbox", "read-only",
                "--output-schema", str(schema_path),
                "--output-last-message", str(output_path),
                "-",
                cwd=workdir,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                _, stderr = await asyncio.wait_for(
                    process.communicate(prompt.encode("utf-8")),
                    timeout=self.timeout_seconds,
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                raise

            if process.returncode != 0:
                detail = stderr.decode("utf-8", errors="replace")
                raise RuntimeError(f"Codex 실행 실패: {detail[-2000:]}")

            result = json.loads(
                output_path.read_text(encoding="utf-8")
            )

        calls = []
        for call in result["tool_calls"]:
            name = call["name"]

            if name not in self.tools:
                raise ValueError(f"등록되지 않은 도구: {name}")

            arguments = json.loads(call["arguments_json"])
            if not isinstance(arguments, dict):
                raise ValueError("도구 인자는 JSON 객체여야 합니다.")

            # 기존 도구 스키마로 실행 전에 검증합니다.
            validated = (
                self.tools[name]
                .get_input_schema()
                .model_validate(arguments)
            )

            calls.append({
                "name": name,
                "args": validated.model_dump(),
                "id": f"call_{uuid4().hex}",
                "type": "tool_call",
            })

        if not calls and not result["answer"].strip():
            raise ValueError("Codex가 답변과 도구 호출을 모두 비웠습니다.")

        return AIMessage(
            content=result["answer"],
            tool_calls=calls,
        )