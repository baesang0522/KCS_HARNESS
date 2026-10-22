import json
import re
import unicodedata

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from services.recommendation.schemas import AdviceRequest, CheckedFinding, ComparisonPlan, Review


# shortcut: 입력 예산은 바이트 기준, 서버 tokenizer 연결 시 실제 토큰 기준으로 교체.
INPUT_BYTES = 24000


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


def batches(items, limit: int, *, overlap: bool = False):
    batch = []
    size = 2

    for item in items:
        cost = byte_size(item) + 1

        if cost + 2 > limit:
            raise ValueError("한 행 또는 검토 결과가 입력 예산을 초과했습니다.")

        if batch and size + cost > limit:
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
    content = dumps({
        **payload,
        "stage": stage,
        "response_schema": schema.model_json_schema(),
    })

    if len(prompt.encode("utf-8")) + len(content.encode("utf-8")) > INPUT_BYTES:
        raise ValueError(
            "분석 입력 예산을 초과했습니다. 원문은 생략하지 않았습니다."
        )

    reply = await model.ainvoke([
        SystemMessage(content=prompt),
        HumanMessage(content=content),
    ])

    if not isinstance(reply, AIMessage):
        raise ValueError("분석 모델 응답 형식이 올바르지 않습니다.")

    reason = reply.response_metadata.get("finish_reason")
    if reason == "length":
        raise ValueError(
            "조언 생성이 토큰 한도로 중단됐습니다. "
            "조언용 출력 예산과 서버 컨텍스트를 확인하세요."
        )
    if reason not in (None, "stop"):
        raise ValueError(f"조언 생성이 정상 종료되지 않았습니다: {reason}")

    if reply.tool_calls or reply.invalid_tool_calls:
        raise ValueError("조언 모델이 예상하지 않은 도구 호출을 반환했습니다.")

    if not isinstance(reply.content, str) or not reply.content.strip():
        raise ValueError("조언 모델의 최종 답변이 비어 있습니다.")

    text = reply.content.strip()
    fenced = re.fullmatch(
        r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if fenced:
        text = fenced[1].strip()

    return schema.model_validate_json(text)


def check_evidence(review: Review, allowed: set[int]):
    for finding in review.findings:
        if not set(finding.excel_rows) <= allowed:
            raise ValueError("제공되지 않은 행을 근거로 인용했습니다.")


def comparison_key(value: str) -> str:
    # 후보 정렬용이며 원문과 실제 셀은 변경하지 않는다.
    return re.sub(
        r"\W+",
        "",
        unicodedata.normalize("NFKC", value).casefold(),
    )


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
    rows = [row.model_dump() for row in data.rows]
    by_row = {row["excel_row"]: row for row in rows}

    base = {
        "question": question,
        "task_type": workspace["task_type"],
        "columns": columns,
    }

    plan = await ask(model, prompt, "plan", base, ComparisonPlan)
    if (
        len(set(plan.column_ids)) != len(plan.column_ids)
        or not set(plan.column_ids) <= set(data.column_ids)
    ):
        raise ValueError("모델이 잘못된 비교 열을 선택했습니다.")

    scan_limit = available_bytes(prompt, base, Review)
    reports = []

    async def scan(ordered_rows, ordering: str):
        for part in batches(ordered_rows, scan_limit, overlap=True):
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

    await scan(rows, "excel_row")

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
    lines = [
        f"분석 대상: {names}",
        f"전체 {data.row_count:,}행의 원문과 열 설명을 검토했습니다.",
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
