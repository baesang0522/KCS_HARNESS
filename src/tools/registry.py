from functools import partial
from pathlib import Path

from langchain_core.tools import BaseTool, StructuredTool
from tools.investigation_service import (
    get_project_tree,
    list_files,
    read_file,
    search_code,
)


def get_local_tools(workspace_root: str) -> list[BaseTool]:
    root = Path(workspace_root).expanduser().resolve()

    if not root.exists():
        raise FileNotFoundError(
            f"workspace_root 가 존재하지 않습니다: {root}"
        )

    if not root.is_dir():
        raise NotADirectoryError(
            f"workspace_root 가 디렉토리가 아닙니다: {root}"
        )

    root_path = str(root)

    return [
        StructuredTool.from_function(
            func=partial(get_project_tree, root_path),
            name="get_project_tree",
            description=(
                "프로젝트의 디렉토리와 파일 구조를 재귀적으로 조회한다. "
                "프로젝트를 처음 탐색할 때 우선 사용한다."
            ),
        ),
        StructuredTool.from_function(
            func=partial(list_files, root_path),
            name="list_files",
            description=(
                "지정한 디렉터리 바로 아래의 파일과 디렉터리 목록을 조회한다."
            ),
        ),
        StructuredTool.from_function(
            func=partial(read_file, root_path),
            name="read_file",
            description=(
                "프로젝트 내부의 UTF-8 텍스트 파일 내용을 읽는다."
            ),
        ),
        StructuredTool.from_function(
            func=partial(search_code, root_path),
            name="search_code",
            description=(
                "프로젝트 내부 텍스트 파일에서 문자열을 재귀적으로 검색한다."
            ),
        ),
    ]






