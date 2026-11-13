"""조언 모델의 입력 예산, 분할 전송 및 구조화 응답 검증."""
import json
import logging
import re

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import ValidationError

from services.errors import MODEL_RESPONSE_ERROR


# shortcut: 입력 예산은 바이트 기준, 서버 tokenizer 연결 시 실제 토큰 기준으로 교체.
INPUT_BYTES = 48000
logger = logging.getLogger(__name__)


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def byte_size(value) -> int:
    return len(dumps(value).encode("utf-8"))


def available_bytes(prompt: str, base: dict, schema) -> int:
    remaining = (
        INPUT_BYTES
        - len(prompt.encode("utf-8"))
        - byte_size({
            **base,
            "response_schema": schema.model_json_schema(),
        })
        - 1024
    )
    if remaining < 1000:
        raise ValueError("질문과 열 설명이 분석 입력 예산을 초과했습니다.")
    return remaining


def batches(items, limit: int, *, overlap: bool = False, max_items: int | None = None):
    batch = []
    size = 2

    for item in items:
        cost = byte_size(item) + 1

        if cost + 2 > limit:
            raise ValueError("한 행 또는 검토 결과가 입력 예산을 초과했습니다.")

        if batch and (size + cost > limit or (max_items is not None and len(batch) >= max_items)):
            yield batch

            batch = batch[-1:] if overlap else []
            size = 2 + sum(byte_size(value) + 1 for value in batch)

            if size + cost > limit:
                raise ValueError(
                    "인접한 두 행을 함께 비교할 입력 공간이 부족합니다."
                )

        batch.append(item)
        size += cost

    if batch:
        yield batch


async def ask(model, prompt: str, stage: str, payload: dict, schema):
    request_payload = {
        **payload,
        "stage": stage,
        "response_schema": schema.model_json_schema(),
    }
    for attempt in range(2):
        content = dumps(request_payload)

        if len(prompt.encode("utf-8")) + len(content.encode("utf-8")) > INPUT_BYTES:
            raise ValueError(
                "AI에 한 번에 보낼 수 있는 입력 크기를 초과했습니다. "
                "추가 열이나 열 설명을 줄인 뒤 다시 요청하세요. 데이터는 생략하지 않았습니다."
            )

        reply = await model.ainvoke([
            SystemMessage(content=prompt),
            HumanMessage(content=content),
        ])

        if not isinstance(reply, AIMessage):
            raise ValueError(MODEL_RESPONSE_ERROR)

        reason = reply.response_metadata.get("finish_reason")
        if reason == "length":
            usage = reply.response_metadata.get("token_usage") or {}
            reasoning = reply.additional_kwargs.get("reasoning_content") or ""
            logger.warning(
                "조언 출력 중단: stage=%s requested_max_tokens=%s prompt_tokens=%s "
                "completion_tokens=%s reasoning_chars=%s content_chars=%s",
                stage, getattr(model, "max_tokens", None), usage.get("prompt_tokens"),
                usage.get("completion_tokens"), len(reasoning), len(reply.content),
            )
            raise ValueError(
                f"조언 생성이 토큰 한도로 중단됐습니다(단계: {stage}). "
                "llm.advice_max_tokens와 서버의 생성·컨텍스트 한도를 확인하세요. "
                "추론이 출력 예산을 소진했을 수도 있습니다."
            )
        if reason not in (None, "stop"):
            raise ValueError(f"조언 생성이 정상 종료되지 않았습니다: {reason}")

        if reply.tool_calls or reply.invalid_tool_calls:
            raise ValueError(MODEL_RESPONSE_ERROR)

        if not isinstance(reply.content, str) or not reply.content.strip():
            raise ValueError(MODEL_RESPONSE_ERROR)

        text = reply.content.strip()
        fenced = re.fullmatch(
            r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```",
            text,
            flags=re.DOTALL | re.IGNORECASE,
        )
        if fenced:
            text = fenced[1].strip()

        try:
            return schema.model_validate_json(text)
        except ValidationError as error:
            errors = error.errors(include_url=False, include_input=False, include_context=False)[:8]
            logger.warning("조언 응답 검증 실패: stage=%s attempt=%s errors=%s", stage, attempt + 1, errors)
            if attempt == 1:
                raise ValueError(
                    MODEL_RESPONSE_ERROR
                ) from error
            request_payload["validation_errors"] = errors


