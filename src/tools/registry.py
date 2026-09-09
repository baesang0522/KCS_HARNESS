from pathlib import Path
from typing import Any

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

    # 작업공간은 하네스가 고정하고, 도구 스키마에는 사용자 인자만 노출한다.
    def project_tree_tool(
        path: str = ".", max_depth: int = 4,
        include_hidden: bool = False, max_entries: int = 500,
    ) -> dict[str, Any]:
        return get_project_tree(root_path, path, max_depth, include_hidden, max_entries)

    def list_files_tool(
        path: str = ".", include_hidden: bool = False, max_entries: int = 200,
    ) -> dict[str, Any]:
        return list_files(root_path, path, include_hidden, max_entries)

    def read_file_tool(
        path: str, start_line: int = 1, end_line: int | None = None,
        max_lines: int = 500, max_chars: int = 20000,
    ) -> dict[str, Any]:
        return read_file(root_path, path, start_line, end_line, max_lines, max_chars)

    def search_code_tool(
        query: str, path: str = ".", file_pattern: str | None = None,
        max_results: int = 100,
    ) -> dict[str, Any]:
        return search_code(root_path, query, path, file_pattern, max_results)

    return [
        StructuredTool.from_function(
            func=project_tree_tool,
            name="get_project_tree",
            description=(
                "프로젝트의 디렉토리와 파일 구조를 재귀적으로 조회한다. "
                "프로젝트를 처음 탐색할 때 우선 사용한다."
            ),
        ),
        StructuredTool.from_function(
            func=list_files_tool,
            name="list_files",
            description=(
                "지정한 디렉터리 바로 아래의 파일과 디렉터리 목록을 조회한다."
            ),
        ),
        StructuredTool.from_function(
            func=read_file_tool,
            name="read_file",
            description=(
                "프로젝트 내부의 UTF-8 텍스트 파일 내용을 읽는다."
            ),
        ),
        StructuredTool.from_function(
            func=search_code_tool,
            name="search_code",
            description=(
                "프로젝트 내부 텍스트 파일에서 문자열을 재귀적으로 검색한다."
            ),
        ),
    ]






