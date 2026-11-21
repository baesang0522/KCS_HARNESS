"""수식 계획 생성과 원본·출력 범위 검증. 작업 상태는 service가 관리한다."""
import asyncio
import json
import re
from pydantic import ValidationError

from services.debug_log import log_event
from services.formula.schemas import CreateFormulaJobRequest, FormulaPlan, range_bounds


FORMULA_JSON_FIELD = re.compile(
    r'("formula"\s*:\s*")(.*?)("\s*,\s*"mode"\s*:)',
    re.DOTALL,
)
SOURCE_DEPENDENT_REQUEST = re.compile(
    r"(?:상품|재고|단가|조회|찾|lookup)", re.IGNORECASE,
)


def validate_source_reference(plan: FormulaPlan, source: CreateFormulaJobRequest) -> None:
    if not plan.actions or not SOURCE_DEPENDENT_REQUEST.search(source.instruction):
        return
    first_cell = source.address.rsplit("!", 1)[-1].split(":", 1)[0].replace("$", "")
    match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d*)", first_cell, re.IGNORECASE)
    if match is None:
        raise ValueError("선택한 원본 범위의 첫 셀을 확인할 수 없습니다.")
    reference = re.compile(
        rf"(?<![A-Z0-9_])\$?{re.escape(match.group(1))}"
        rf"\$?{match.group(2)}(?![A-Z0-9_])",
        re.IGNORECASE,
    )
    if not any(reference.search(action.formula) for action in plan.actions):
        raise ValueError("조회·상품 작업 수식이 선택한 원본 키를 참조하지 않습니다.")


def validate_output_scope(plan: FormulaPlan, source: CreateFormulaJobRequest) -> None:
    for action in plan.actions:
        first, col, last, _ = range_bounds(action.target_range)
        if first < source.row_start + 1 or last > source.row_start + source.row_count:
            raise ValueError("수식 결과는 선택한 데이터 행 범위 안에 있어야 합니다.")
        if source.column_start < col <= source.column_start + source.column_count:
            raise ValueError("수식 결과 범위가 원본 선택 범위와 겹칩니다.")


def validate_reference_sheets(plan: FormulaPlan, source: CreateFormulaJobRequest) -> None:
    if not source.reference_sheets:
        return
    known = {source.sheet_name.casefold(), *(sheet.sheet_name.casefold() for sheet in source.reference_sheets)}
    qualifier = re.compile(r"(?:'((?:[^']|'')+)'|([\w가-힣]+))!")
    for action in plan.actions:
        formula = re.sub(r'"(?:[^"]|"")*"', '""', action.formula)
        for match in qualifier.finditer(formula):
            name = (match.group(1) or match.group(2)).replace("''", "'")
            if name.casefold() not in known:
                raise ValueError("실제로 확인한 참조 시트 이름으로 수식을 다시 준비하세요.")


def parse_formula_plan(raw: str) -> FormulaPlan:
    try:
        return FormulaPlan.model_validate_json(raw)
    except ValidationError as original:
        if not any(error["type"] == "json_invalid" for error in original.errors()):
            raise
        # Repair only an unescaped quote inside the known formula field.
        # Other malformed JSON remains a planning failure.
        match = FORMULA_JSON_FIELD.search(raw)
        if match is None:
            raise original
        repaired = (
            raw[:match.start(1)]
            + match.group(1)[:-1]
            + json.dumps(match.group(2), ensure_ascii=False)
            + match.group(3)[1:]
            + raw[match.end(3):]
        )
        return FormulaPlan.model_validate_json(repaired)


async def generate_formula_plan(source, planning_context, runtime) -> FormulaPlan:
    payload = {
        "instruction": source.instruction,
        "context": (
            planning_context.model_dump(mode="json")
            if planning_context else None
        ),
        "selection": {
            "worksheet_id": source.worksheet_id,
            "sheet_name": source.sheet_name,
            "address": source.address,
            "row_start_zero_based": source.row_start,
            "column_start_zero_based": source.column_start,
            "row_count": source.row_count,
            "column_count": source.column_count,
            "samples": [row.model_dump() for row in source.samples],
            "input_columns": [column.model_dump() for column in source.input_columns],
        },
        "reference_sheets": [sheet.model_dump(mode="json") for sheet in source.reference_sheets],
        "sheet_context": (
            source.sheet_context.model_dump(mode="json")
            if source.sheet_context else None
        ),
    }
    # 재생성도 같은 계획 요청의 시간 한도 안에서만 수행한다.
    async with asyncio.timeout(runtime.settings.llm.timeout_seconds + 10):
        for attempt in range(2):
            response = await runtime.respond(runtime.formula_prompt, payload)
            try:
                plan = parse_formula_plan(response.content.strip())
                validate_source_reference(plan, source)
                validate_output_scope(plan, source)
                validate_reference_sheets(plan, source)
                return plan
            except ValueError as error:
                errors = (error.errors(include_url=False, include_input=False, include_context=False)
                          if isinstance(error, ValidationError) else [{"type": "value_error", "msg": str(error)}])
                log_event("formula.plan.validation_failed", level="WARNING", conversation_id=str(source.conversation_id),
                          origin_request_id=str(source.origin_request_id) if source.origin_request_id else None,
                          job_id=str(source.formula_job_id), job_kind="formula", attempt=attempt + 1,
                          validation_errors=errors, will_retry=attempt == 0)
                if attempt == 1:
                    raise
                payload = {**payload, "validation_errors": errors}
