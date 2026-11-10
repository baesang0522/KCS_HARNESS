"""선정된 데이터를 검토하고 제안을 종합·근거 확인한다."""
from services.errors import MODEL_RESPONSE_ERROR
from services.recommendation.model_io import ask, available_bytes, batches
from services.recommendation.selection import comparison_key, top_model_combinations
from services.recommendation.schemas import AdviceRequest, CheckedFinding, ComparisonPlan, Review


SCAN_MAX_ROWS = 100


def check_evidence(review: Review, allowed: set[int]):
    for finding in review.findings:
        if not set(finding.excel_rows) <= allowed:
            raise ValueError(MODEL_RESPONSE_ERROR)


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
