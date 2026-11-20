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
