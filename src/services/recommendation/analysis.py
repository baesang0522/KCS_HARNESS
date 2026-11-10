import json
import logging
import re
import unicodedata

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import ValidationError

from services.errors import MODEL_RESPONSE_ERROR
from services.recommendation.schemas import AdviceRequest, CheckedFinding, ComparisonPlan, Review, TOP_COMBINATIONS


# shortcut: 입력 예산은 바이트 기준, 서버 tokenizer 연결 시 실제 토큰 기준으로 교체.
INPUT_BYTES = 48000
SCAN_MAX_ROWS = 100
MODEL_GROUP_ROLES = ("declared_name", "trade_name", "model_spec")
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
                "분석 입력 예산을 초과했습니다. 원문은 생략하지 않았습니다."
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


def check_evidence(review: Review, allowed: set[int]):
    for finding in review.findings:
        if not set(finding.excel_rows) <= allowed:
            raise ValueError(MODEL_RESPONSE_ERROR)


def comparison_key(value: str) -> str:
    # 후보 정렬용이며 원문과 실제 셀은 변경하지 않는다.
    return re.sub(
        r"\W+",
        "",
        unicodedata.normalize("NFKC", value).casefold(),
    )


def top_model_combinations(data: AdviceRequest, columns: list[dict]) -> tuple[list[dict], dict]:
    indexes = []
    for role in MODEL_GROUP_ROLES:
        matches = [i for i, column in enumerate(columns) if column.get("role") == role]
        if len(matches) != 1:
            raise ValueError("빈도 집계에는 신고품명·거래품명·모델규격명 열이 필요합니다.")
        indexes.append(matches[0])

    if data.selection is not None:
        if data.selection.group_column_ids != [columns[i]["column_id"] for i in indexes]:
            raise ValueError("집계 기준은 신고품명·거래품명·모델규격명이어야 합니다.")
        return [
            {"excel_row": row.excel_row, "values": [value.upper() for value in row.values], "count": row.count}
            for row in data.rows
        ], data.selection.model_dump()

    groups = {}
    for row in data.rows:
        key = tuple(row.values[i].upper() for i in indexes)
        if key not in groups:
            groups[key] = {"row": row, "count": 0}
        groups[key]["count"] += 1

    selected = sorted(groups.values(), key=lambda item: (-item["count"], item["row"].excel_row))[:TOP_COMBINATIONS]
    # shortcut: 추가 열은 첫 실제 행의 예시만 제공한다. 그룹 내 차이 분석이 필요하면 별도 집계를 추가한다.
    rows = [
        {"excel_row": item["row"].excel_row,
         "values": [value.upper() for value in item["row"].values],
         "count": item["count"]}
        for item in selected
    ]
    return rows, {
        "mode": "uppercase_top_combinations",
        "group_column_ids": [columns[i]["column_id"] for i in indexes],
        "total_rows": data.row_count,
        "total_combinations": len(groups),
        "selected_combinations": len(rows),
        "represented_rows": sum(row["count"] for row in rows),
        "additional_values": "first_row_example_only",
    }


async def generate_advice(
    runtime,
    question: str,
    workspace: dict,
    data: AdviceRequest,
):
    model = runtime.advice_model
    if model is None:
        raise ValueError("조언용 모델이 설정되지 않았습니다.")

    prompt = runtime.recommendation_prompt

    by_id = {
        str(column["column_id"]): column
        for column in workspace["columns"]
    }
    columns = [by_id[column_id] for column_id in data.column_ids]
    selection = None
    if workspace["task_type"] == "model_normalization":
        rows, selection = top_model_combinations(data, columns)
    else:
        if data.selection is not None:
            raise ValueError("상위 조합 집계는 모델규격 정제에서만 지원합니다.")
        rows = [row.model_dump(exclude_none=True) for row in data.rows]
    by_row = {row["excel_row"]: row for row in rows}

    base = {
        "question": question,
        "task_type": workspace["task_type"],
        "columns": columns,
    }
    if selection is not None:
        base["selection"] = selection

    plan = await ask(model, prompt, "plan", base, ComparisonPlan)
    if (
        len(set(plan.column_ids)) != len(plan.column_ids)
        or not set(plan.column_ids) <= set(data.column_ids)
    ):
        raise ValueError(MODEL_RESPONSE_ERROR)

    scan_limit = available_bytes(prompt, base, Review)
    reports = []

    async def scan(ordered_rows, ordering: str):
        for part in batches(ordered_rows, scan_limit, overlap=True, max_items=SCAN_MAX_ROWS):
            review = await ask(
                model,
                prompt,
                "scan",
                {**base, "ordering": ordering, "rows": part},
                Review,
            )
            check_evidence(review, {row["excel_row"] for row in part})
            if review.findings:
                reports.append(review.model_dump())

    await scan(rows, "frequency_desc" if selection else "excel_row")

    for column_id in plan.column_ids:
        index = data.column_ids.index(column_id)
        ordered = sorted(
            rows,
            key=lambda row: (
                comparison_key(row["values"][index]),
                row["excel_row"],
            ),
        )
        await scan(ordered, column_id)

    merge_limit = available_bytes(prompt, base, Review)

    while len(reports) > 1:
        parts = list(batches(reports, merge_limit))
        if len(parts) == len(reports):
            raise ValueError("검토 결과를 통합할 입력 공간이 부족합니다.")

        merged = []
        for part in parts:
            allowed = {
                number
                for report in part
                for finding in report["findings"]
                for number in finding["excel_rows"]
            }
            review = await ask(
                model,
                prompt,
                "merge",
                {**base, "reviews": part},
                Review,
            )
            check_evidence(review, allowed)
            if review.findings:
                merged.append(review.model_dump())

        reports = merged

    final = Review.model_validate(reports[0]) if reports else Review()
    checked = []

    for finding in final.findings:
        evidence = [
            by_row[number]
            for number in dict.fromkeys(finding.excel_rows)
        ]
        result = await ask(
            model,
            prompt,
            "verify",
            {
                **base,
                "proposal": finding.model_dump(),
                "rows": evidence,
            },
            CheckedFinding,
        )
        if result.finding is not None:
            check_evidence(
                Review(findings=[result.finding]),
                {row["excel_row"] for row in evidence},
            )
            checked.append(result.finding)

    names = ", ".join(column["header"] for column in columns)
    scope = (
        f"전체 {data.row_count:,}행을 대문자로 변환해 신고품명·거래품명·모델규격명 조합별로 집계하고, "
        f"{selection['total_combinations']:,}개 조합 중 빈도 상위 {len(rows):,}개를 검토했습니다.\n"
        f"선정 조합에 해당하는 원본은 {selection['represented_rows']:,}행입니다. "
        "추가 열·결과 열은 조합별 첫 행의 대문자 변환 예시이며 그룹 전체를 대표하지 않습니다."
        if selection else f"전체 {data.row_count:,}행의 원문과 열 설명을 검토했습니다."
    )
    lines = [
        f"분석 대상: {names}",
        scope,
        f"{len(plan.column_ids)}개 열 기준으로 정렬하여 그룹화 후보도 검토했습니다.",
        "아래는 우선 확인할 제안이며 모든 행 쌍의 비교 결과는 아닙니다. "
        "셀은 변경하지 않았습니다.",
    ]

    if not checked:
        lines.append(
            "원본 근거를 확인한 추가 전처리·그룹화 제안을 확정하지 못했습니다."
        )

    for index, finding in enumerate(checked, 1):
        numbers = ", ".join(
            map(str, dict.fromkeys(finding.excel_rows))
        )
        lines.append(
            f"{index}. {finding.advice}\n"
            f"근거: 현재 작업 시트의 {numbers}행"
        )

    return "\n\n".join(lines)
