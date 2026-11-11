import asyncio
import json
import tempfile
from copy import copy
from pathlib import Path
from uuid import uuid4

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool


OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}

class CodexModel:
    def __init__(self, model:str, timeout_seconds: float = 120):
        self.model = model
        self.timeout_seconds = timeout_seconds

    def bind_tools(self, tools, *, tool_choice="required", parallel_tool_calls=False):
        if tool_choice != "required" or parallel_tool_calls:
            raise ValueError("Codex 요청 분류는 도구 하나만 선택합니다.")
        bound = copy(self)
        bound._tools = [convert_to_openai_tool(tool)["function"] for tool in tools]
        return bound

    async def ainvoke(self, messages) -> AIMessage:
        tools = getattr(self, "_tools", None)
        schema = OUTPUT_SCHEMA
        instruction = (
            "conversation의 system 지시와 최신 사용자 요청에 따라 응답한다. "
            "Codex 자체 도구·셸·검색·파일을 사용하지 않는다. "
            "대화의 데이터만 사용한다. "
        )
        payload = {"conversation": []}
        for message in messages:
            item = {"role": message.type, "content": message.content}
            if isinstance(message, AIMessage) and message.tool_calls:
                item["tool_calls"] = message.tool_calls
            if isinstance(message, ToolMessage):
                item["tool_call_id"] = message.tool_call_id
            payload["conversation"].append(item)
        if tools:
            # CLI의 최종 JSON을 하네스 도구 호출로 변환하며 실행·검증은 공통 그래프가 맡는다.
            instruction += (
                "tools 중 하나를 선택해 name과 arguments를 반환한다. "
                "arguments는 해당 도구 인자 객체를 JSON 문자열로 직렬화한 값이다. "
                "이 JSON이 conversation에서 요구하는 도구 호출의 전달 형식이다. "
                "tool 오류가 있으면 인자를 수정하거나 ask_user를 선택한다."
            )
            payload["tools"] = tools
            schema = {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "enum": [tool["name"] for tool in tools]},
                    "arguments": {"type": "string"},
                },
                "required": ["name", "arguments"], "additionalProperties": False,
            }
        else:
            instruction += "answer에 응답 본문을 반환한다. JSON을 요구하면 JSON 객체를 문자열로 담는다."
        prompt = instruction + "\n" + json.dumps(payload, ensure_ascii=False)
        result = await self._execute(prompt, schema)
        if tools:
            if (not isinstance(result, dict) or set(result) != {"name", "arguments"}
                    or not isinstance(result["name"], str)
                    or result["name"] not in {tool["name"] for tool in tools}
                    or not isinstance(result["arguments"], str)):
                raise ValueError("Codex 도구 응답 형식이 올바르지 않습니다.")
            call_id = str(uuid4())
            try:
                args = json.loads(result["arguments"])
                if not isinstance(args, dict):
                    raise ValueError("도구 인자는 객체여야 합니다.")
            except ValueError:
                return AIMessage(content="", invalid_tool_calls=[{
                    "name": result["name"], "args": result["arguments"],
                    "id": call_id, "error": "유효하지 않은 도구 인자",
                }])
            return AIMessage(content="", tool_calls=[{
                "name": result["name"], "args": args, "id": call_id,
            }])
        if not isinstance(result, dict) or set(result) != {"answer"}:
            raise ValueError("Codex 응답 형식이 올바르지 않습니다.")
        answer = result["answer"]
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError("Codex 답변이 비어 있습니다.")
        return AIMessage(content=answer)

    async def _execute(self, prompt, schema):
        # 요청마다 독립된 임시 폴더를 사용합니다.
        with tempfile.TemporaryDirectory(prefix="kcs-codex-") as directory:
            workdir = Path(directory)
            schema_path = workdir / "schema.json"
            output_path = workdir / "answer.json"

            schema_path.write_text(
                json.dumps(schema),
                encoding="utf-8",
            )

            process = await asyncio.create_subprocess_exec(
                "codex",
                "exec",
                "--model", self.model,
                "--skip-git-repo-check",
                "--ephemeral",
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

        return result
