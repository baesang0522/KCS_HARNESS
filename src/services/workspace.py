"""기능에 관계없이 현재 작업표의 실제 열 ID를 검증한다."""
from services.errors import SHARED_MESSAGES


def resolve_columns(
    workspace: dict | None,
    ids: list[str] | None,
) -> list[str]:
    if not workspace:
        raise ValueError(SHARED_MESSAGES["WORKSPACE_REQUIRED"])

    known = [str(column["column_id"]) for column in workspace["columns"]]
    selected = known if ids is None else ids

    if not selected:
        raise ValueError("분석할 열이 없습니다.")
    if len(set(selected)) != len(selected):
        raise ValueError("분석 대상 열이 중복되었습니다.")
    if not set(selected) <= set(known):
        raise ValueError("현재 작업 표에 없는 열입니다.")

    return selected


def summarize_row_scopes(value):
    """모델에는 고정 행의 개수만 설명하고, 실행·검증용 행 ID 목록은 원본 문맥에 유지한다."""
    if isinstance(value, dict):
        return {(key + "_count" if key in {"row_ids", "base_ids"} and isinstance(item, list) else key):
                (len(item) if key in {"row_ids", "base_ids"} and isinstance(item, list) else summarize_row_scopes(item))
                for key, item in value.items()}
    if isinstance(value, list):
        return [summarize_row_scopes(item) for item in value]
    return value
