import asyncio
import json
import tempfile
from pathlib import Path

from langchain_core.messages import AIMessage


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

    async def ainvoke(self, messages) -> AIMessage:
        instruction = """
            아래 conversation의 system 메시지와 대화 흐름에 따라 응답하라.
            answer에 응답 본문을 반환하라. system 메시지가 JSON을 요구하면
            해당 JSON 객체를 문자열로 담아라.
            Codex 자체 도구나 셸을 사용해 작업을 대신 수행하지 마라.
            """
        prompt = instruction + "\n" + json.dumps(
            {"conversation": [
                {"role": message.type, "content": message.content}
                for message in messages
            ]},
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
                "--model", self.model,
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

        if not isinstance(result, dict) or set(result) != {"answer"}:
            raise ValueError("Codex 응답 형식이 올바르지 않습니다.")
        answer = result["answer"]
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError("Codex 답변이 비어 있습니다.")
        return AIMessage(content=answer)
