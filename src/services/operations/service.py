from services.operations.rules import preprocess, split_value
from services.operations.schemas import OperationRequest, OperationResponse, Row, mapping_key


def value_catalog(values: list[str]) -> dict:
    items = {}
    blanks = 0
    for value in values:
        key = mapping_key(value)
        if not key:
            blanks += 1
            continue
        item = items.setdefault(key, {"key": key, "example": value, "count": 0})
        item["count"] += 1
    return {"items": list(items.values()), "blank_count": blanks}


def execute(payload: OperationRequest) -> OperationResponse:
    operation = payload.operation
    mappings = {mapping_key(item.source): item.target for item in operation.mappings}
    if operation.kind == "group":
        source = next((row for row in payload.rows if row.excel_row == operation.source_row), None)
        if source is None:
            raise ValueError("기준 행이 현재 처리 범위에 없습니다.")
        criteria = tuple(mapping_key(value) for value in source.values[:-1])
        if not all(criteria):
            raise ValueError("기준 행의 판단 기준에 빈 값이 있습니다. 다른 행이나 기준 열을 선택하세요.")
        representative = operation.representative if operation.representative is not None else source.values[-1]
        if not representative.strip():
            raise ValueError("기준 행의 대표값이 비어 있습니다. 셀을 수정하거나 대표값을 입력하세요.")

    result, changed = [], 0
    for row in payload.rows:
        if operation.kind == "preprocess":
            values = [preprocess(row.values[0], operation.rules)]
        elif operation.kind == "split":
            if operation.part == "last":
                parts = row.values[0].rsplit(operation.delimiter, 1)
                values = [parts[-1] if len(parts) > 1 else ""]
            else:
                values = split_value(row.values[0], operation.delimiter)
        elif operation.kind == "replace":
            value = row.values[0]
            expected = len(value) + value.count(operation.find) * (len(operation.replacement) - len(operation.find))
            if expected > 32767:
                raise ValueError("치환 결과가 Excel 셀 길이 32,767자를 초과합니다.")
            values = [value.replace(operation.find, operation.replacement)]
        elif operation.kind == "map":
            values = [mappings.get(mapping_key(row.values[0]), row.values[0])]
        else:
            key = tuple(mapping_key(value) for value in row.values[:-1])
            values = [representative if key == criteria else row.values[-1]]
        before = row.values[-1:] if operation.kind == "group" else row.values
        changed += values != before
        result.append(Row(excel_row=row.excel_row, values=values))
    width = max(len(row.values) for row in result)
    if width * len(result) > 2000000:
        raise ValueError("결과가 200만 셀을 초과합니다. 대상 행이나 분리 열을 줄여 주세요.")
    headers = (["정제"] if operation.kind == "preprocess" else
               ["치환"] if operation.kind == "replace" else
               ["대표값"] if operation.kind == "map" else
               ["대표값"] if operation.kind == "group" else
               ["마지막 단어"] if operation.part == "last" else
               [f"단어 {index + 1}" for index in range(width)])
    return OperationResponse(headers=headers, rows=result, changed_count=changed)
