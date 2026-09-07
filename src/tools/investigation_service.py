# 보안상 agent가 아닌 harness가 workspace_root를 제공함
import os
from pathlib import Path
from typing import Any


DEFAULT_IGNORE_DIRS = {
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".ipynb_checkpoints",
    "node_modules",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}


def _resolve_path(
    workspace_root: str,
    path: str,
) -> tuple[Path, Path]:
    """
    작업공간 루트와 상대 경로를 안전한 실제 경로로 변환합니다.

    `..` 또는 심볼릭 링크 등을 이용해 작업공간 바깥으로 접근하려는 경우
    PermissionError를 발생시킵니다.

    Args:
        workspace_root:
            현재 작업 대상 프로젝트 또는 작업공간의 루트 경로입니다.

            MCP 클라이언트가 전달하는 실제 파일 시스템 경로이며,
            Agent가 파일을 탐색할 수 있는 최상위 경계를 의미합니다.

            예:
                "/home/user/project"
                "/workspace/my_project"

        path:
            workspace_root를 기준으로 접근할 상대 경로입니다.

            "."은 workspace_root 자체를 의미합니다.

            예:
                "."
                "src"
                "src/services"
                "notebooks/test.ipynb"

    Returns:
        다음 두 Path 객체를 tuple로 반환합니다.

        - root:
            resolve된 workspace_root의 절대 경로

        - target:
            workspace_root와 path를 결합한 실제 절대 경로

    Raises:
        FileNotFoundError:
            workspace_root 또는 지정한 path가 존재하지 않는 경우 발생합니다.

        NotADirectoryError:
            workspace_root가 디렉토리가 아닌 경우 발생합니다.

        PermissionError:
            지정한 path가 workspace_root 바깥을 가리키는 경우 발생합니다.
    """
    root = Path(workspace_root).expanduser().resolve()

    if not root.exists():
        raise FileNotFoundError(
            f"workspace_root가 존재하지 않습니다: {workspace_root}"
        )

    if not root.is_dir():
        raise NotADirectoryError(
            f"workspace_root가 디렉토리가 아닙니다: {workspace_root}"
        )

    target = (root / path).resolve()

    if target != root and root not in target.parents:
        raise PermissionError(
            f"작업공간 외부 경로에는 접근할 수 없습니다: {path}"
        )

    if not target.exists():
        raise FileNotFoundError(
            f"경로가 존재하지 않습니다: {path}"
        )

    return root, target


def _relative_path(
    root: Path,
    path: Path,
) -> str:
    """
    실제 절대 경로를 작업공간 기준 상대 경로로 변환합니다.

    Agent에게 서버의 실제 절대 경로를 불필요하게 노출하지 않고,
    이후 다른 파일 탐색 툴에서 그대로 사용할 수 있는 상대 경로를
    제공하기 위해 사용합니다.

    Args:
        root:
            현재 작업공간의 절대 루트 경로입니다.

        path:
            상대 경로로 변환할 작업공간 내부의 절대 경로입니다.

    Returns:
        root를 기준으로 변환된 POSIX 형식의 상대 경로를 반환합니다.

        root 자체인 경우 "."을 반환합니다.

        예:
            "."
            "src"
            "src/services/auth.py"

    Raises:
        ValueError:
            path가 root의 하위 경로가 아닌 경우 발생할 수 있습니다.
    """
    if path == root:
        return "."

    return path.relative_to(root).as_posix()


def _should_ignore(
    path: Path,
    include_hidden: bool,
) -> bool:
    """
    프로젝트 탐색 결과에서 제외할 파일 또는 디렉토리인지 판단합니다.

    숨김 항목과 가상환경, Git 내부 데이터, 캐시 디렉토리 등
    Agent의 코드 탐색에 대부분 필요하지 않은 항목을 제외하기 위해 사용합니다.

    Args:
        path:
            제외 여부를 판단할 파일 또는 디렉토리의 Path 객체입니다.

        include_hidden:
            이름이 "."으로 시작하는 숨김 파일과 디렉토리를
            탐색 결과에 포함할지 여부입니다.

            False인 경우 숨김 항목을 제외합니다.
            True인 경우 일반 숨김 항목은 포함합니다.

            단, DEFAULT_IGNORE_DIRS에 등록된 디렉토리는
            include_hidden 값과 관계없이 제외합니다.

    Returns:
        탐색 결과에서 제외해야 하면 True,
        포함해야 하면 False를 반환합니다.
    """
    name = path.name

    if not include_hidden and name.startswith("."):
        return True

    if path.is_dir() and name in DEFAULT_IGNORE_DIRS:
        return True

    return False


def list_files(
    workspace_root: str,
    path: str = ".",
    include_hidden: bool = False,
    max_entries: int = 200,
) -> dict[str, Any]:
    """
    지정한 디렉토리 바로 아래의 파일과 디렉토리 목록을 조회합니다.

    특정 디렉토리 내부를 국소적으로 탐색할 때 사용합니다.
    하위 디렉토리를 재귀적으로 탐색하지 않습니다.

    프로젝트 전체 구조를 먼저 파악해야 하는 경우에는
    `get_project_tree`를 사용하세요.

    관련 파일을 찾은 후 실제 코드 내용을 확인하려면
    `read_file` 또는 `search_code`를 사용하세요.

    Args:
        workspace_root:
            현재 작업 대상 프로젝트 또는 작업공간의 루트 경로입니다.

            모든 파일 접근은 이 경로 내부로 제한됩니다.
            MCP 클라이언트가 현재 작업공간의 실제 경로를 전달해야 합니다.

            예:
                "/home/user/project"
                "/workspace/my_project"

        path:
            조회할 디렉토리의 workspace_root 기준 상대 경로입니다.

            "."은 프로젝트 루트를 의미합니다.

            이 툴은 지정한 디렉토리의 바로 아래 항목만 반환하며,
            하위 디렉토리를 재귀적으로 탐색하지 않습니다.

            예:
                "."
                "src"
                "src/services"
                "tests"

        include_hidden:
            이름이 "."으로 시작하는 숨김 파일과 디렉토리를
            결과에 포함할지 여부입니다.

            기본값은 False입니다.

            False:
                ".env", ".config" 등의 숨김 항목을 제외합니다.

            True:
                일반 숨김 항목을 포함합니다.

            단, .git, .venv 등 DEFAULT_IGNORE_DIRS에 등록된
            고노이즈 디렉토리는 항상 제외합니다.

        max_entries:
            반환할 최대 파일 및 디렉토리 개수입니다.

            대규모 디렉토리의 결과가 Agent의 컨텍스트를
            과도하게 사용하는 것을 방지하기 위한 제한입니다.

            기본값은 200입니다.

            실제 항목 수가 이 값을 초과하면
            반환 결과의 `truncated`가 True가 됩니다.

    Returns:
        다음 형식의 dictionary를 반환합니다.

        {
            "path": "src",
            "entries": [
                {
                    "name": "services",
                    "path": "src/services",
                    "type": "directory"
                },
                {
                    "name": "main.py",
                    "path": "src/main.py",
                    "type": "file",
                    "size": 4210
                }
            ],
            "truncated": False
        }

        path:
            조회한 디렉토리의 workspace 기준 상대 경로입니다.

        entries:
            조회된 파일과 디렉토리 목록입니다.

        name:
            파일 또는 디렉토리 이름입니다.

        path:
            이후 다른 파일 툴에서 사용할 수 있는 workspace 기준 상대 경로입니다.

        type:
            "file" 또는 "directory"입니다.

        size:
            파일 크기(byte)입니다.
            디렉토리에는 포함되지 않습니다.

        truncated:
            max_entries 제한으로 일부 결과가 생략되었는지 여부입니다.

    Raises:
        FileNotFoundError:
            workspace_root 또는 지정한 path가 존재하지 않는 경우 발생합니다.

        NotADirectoryError:
            workspace_root 또는 지정한 path가 디렉토리가 아닌 경우 발생합니다.

        PermissionError:
            workspace_root 바깥의 경로에 접근하려는 경우 또는
            해당 디렉토리를 읽을 권한이 없는 경우 발생합니다.

        ValueError:
            max_entries가 1보다 작은 경우 발생합니다.

    Agent 사용 지침:
        - 특정 디렉토리 내부를 확인할 때 사용하세요.
        - 프로젝트 전체 구조 확인에는 get_project_tree를 사용하세요.
        - 이 툴은 파일 내용을 반환하지 않습니다.
        - 파일명만 보고 코드의 동작을 판단하지 마세요.
        - 관련 파일을 찾았다면 read_file 또는 search_code로 내용을 확인하세요.
    """
    if max_entries < 1:
        raise ValueError(
            "max_entries는 1 이상이어야 합니다."
        )

    root, target = _resolve_path(
        workspace_root=workspace_root,
        path=path,
    )

    if not target.is_dir():
        raise NotADirectoryError(
            f"디렉토리가 아닙니다: {path}"
        )

    entries: list[dict[str, Any]] = []
    truncated = False

    try:
        children = sorted(
            target.iterdir(),
            key=lambda item: (
                not item.is_dir(),
                item.name.lower(),
            ),
        )
    except PermissionError as exc:
        raise PermissionError(
            f"디렉토리를 읽을 권한이 없습니다: {path}"
        ) from exc

    for child in children:
        if _should_ignore(
            child,
            include_hidden=include_hidden,
        ):
            continue

        if len(entries) >= max_entries:
            truncated = True
            break

        entry: dict[str, Any] = {
            "name": child.name,
            "path": _relative_path(root, child),
            "type": (
                "directory"
                if child.is_dir()
                else "file"
            ),
        }

        if child.is_file():
            try:
                entry["size"] = child.stat().st_size
            except OSError:
                entry["size"] = None

        entries.append(entry)

    return {
        "path": _relative_path(root, target),
        "entries": entries,
        "truncated": truncated,
    }


def read_file(
    workspace_root: str,
    path: str,
    start_line: int = 1,
    end_line: int | None = None,
    max_lines: int = 500,
    max_chars: int = 20000,
) -> dict[str, Any]:
    """
    UTF-8 텍스트 파일의 지정한 줄 범위를 제한된 크기로 읽는다.

    요청 범위와 continuation 판단에 필요한 다음 한 줄까지만 읽는다.
    content에는 줄 번호를 추가하지 않는다. max_lines와 max_chars 중
    먼저 도달한 제한에서 완전한 줄 단위로 결과를 자른다.

    Args:
        workspace_root:
            파일 접근을 허용할 작업공간 루트 경로.

            예:
                "/workspace/project"

        path:
            workspace_root 기준 파일 경로. 절대 경로나 workspace 밖을
            가리키는 `..`, 심볼릭 링크는 허용하지 않는다.

            예:
                "src/main.py"
                "README.md"

        start_line:
            읽기 시작할 1-based 줄 번호. 기본값은 1이다.

            예:
                1
                501

        end_line:
            읽기를 끝낼 1-based 줄 번호. 해당 줄을 포함한다.
            생략하면 파일 끝까지를 요청 범위로 사용한다.

            예:
                100
                None

        max_lines:
            content에 포함할 최대 줄 수. 기본값은 500이다.

            예:
                200

        max_chars:
            content에 포함할 최대 문자 수. 기본값은 20000이다.
            다음 줄 전체를 추가했을 때 제한을 넘으면 해당 줄은 반환하지
            않고 next_start_line으로 넘긴다.

            예:
                10000

    Returns:
        다음 형식의 dictionary를 반환한다.

        {
            "path": "src/main.py",
            "content": "...",
            "start_line": 1,
            "end_line": 420,
            "file_size": 823451,
            "truncated": True,
            "next_start_line": 421
        }

        end_line은 content에 포함된 마지막 줄 번호다. 반환할 줄이 없으면
        None이다. file_size는 파일의 byte 크기다. next_start_line은
        truncated가 True일 때만 포함한다.

    Raises:
        FileNotFoundError:
            workspace_root 또는 path가 존재하지 않을 때 발생한다.

        NotADirectoryError:
            workspace_root가 디렉토리가 아닐 때 발생한다.

        IsADirectoryError:
            path가 일반 파일이 아닌 디렉토리일 때 발생한다.

        PermissionError:
            workspace 밖에 접근하거나 파일 읽기 권한이 없을 때 발생한다.

        ValueError:
            줄 범위나 제한값이 잘못됐거나, .ipynb·binary·UTF-8이 아닌
            파일을 요청할 때 발생한다. 단일 줄이 max_chars보다 길 때도
            내용 유실을 방지하기 위해 발생한다.

    Agent 사용 지침:
        - 큰 파일은 start_line과 end_line으로 필요한 범위만 요청해라.
        - truncated가 True면 next_start_line부터 이어서 읽어라.
        - content에 줄 번호가 없으므로 반환된 범위 정보와 함께 해석해라.
    """
    if start_line < 1:
        raise ValueError(
            "start_line은 1 이상이어야 합니다."
        )

    if end_line is not None and end_line < start_line:
        raise ValueError(
            "end_line은 start_line 이상이어야 합니다."
        )

    if max_lines < 1:
        raise ValueError(
            "max_lines는 1 이상이어야 합니다."
        )

    if max_chars < 1:
        raise ValueError(
            "max_chars는 1 이상이어야 합니다."
        )

    root, target = _resolve_path(
        workspace_root=workspace_root,
        path=path,
    )

    if not target.is_file():
        raise IsADirectoryError(
            f"파일이 아닙니다: {path}"
        )

    if target.suffix.lower() == ".ipynb":
        raise ValueError(
            ".ipynb 파일은 read_file로 읽을 수 없습니다."
        )

    try:
        file_size = target.stat().st_size
    except PermissionError as exc:
        raise PermissionError(
            f"파일 정보를 읽을 권한이 없습니다: {path}"
        ) from exc

    content_parts: list[str] = []
    content_char_count = 0
    returned_line_count = 0
    returned_end_line: int | None = None
    truncated = False
    next_start_line: int | None = None

    try:
        with target.open(
            mode="rb",
        ) as file:
            for line_number, raw_line in enumerate(
                file,
                start=1,
            ):
                line = raw_line.decode(
                    "utf-8",
                    errors="strict",
                )

                if any(
                    (
                        ord(character) < 32
                        and character not in "\t\n\r\f"
                    )
                    or ord(character) == 127
                    for character in line
                ):
                    raise ValueError(
                        f"binary 파일은 읽을 수 없습니다: {path}"
                    )

                if line_number < start_line:
                    continue

                if (
                    end_line is not None
                    and line_number > end_line
                ):
                    break

                if returned_line_count >= max_lines:
                    truncated = True
                    next_start_line = line_number
                    break

                if len(line) > max_chars:
                    raise ValueError(
                        "단일 줄의 문자 수가 max_chars를 초과합니다: "
                        f"line={line_number}, "
                        f"line_chars={len(line)}, "
                        f"max_chars={max_chars}"
                    )

                if (
                    content_char_count + len(line)
                    > max_chars
                ):
                    truncated = True
                    next_start_line = line_number
                    break

                content_parts.append(line)
                content_char_count += len(line)
                returned_line_count += 1
                returned_end_line = line_number

                if (
                    end_line is not None
                    and line_number == end_line
                ):
                    break
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"UTF-8 텍스트 파일만 읽을 수 있습니다: {path}"
        ) from exc
    except PermissionError as exc:
        raise PermissionError(
            f"파일을 읽을 권한이 없습니다: {path}"
        ) from exc

    result: dict[str, Any] = {
        "path": _relative_path(root, target),
        "content": "".join(content_parts),
        "start_line": start_line,
        "end_line": returned_end_line,
        "file_size": file_size,
        "truncated": truncated,
    }

    if truncated:
        result["next_start_line"] = next_start_line

    return result


def search_code(
    workspace_root: str,
    query: str,
    path: str = ".",
    file_pattern: str | None = None,
    max_results: int = 100,
) -> dict[str, Any]:
    """
    workspace 내부의 UTF-8 텍스트 파일에서 문자열을 재귀 검색한다.

    대소문자를 구분하지 않는 단순 문자열 검색만 수행한다. 매치된 파일
    전체가 아닌 workspace 상대 경로, 줄 번호, 해당 줄만 반환한다.

    Args:
        workspace_root:
            검색을 허용할 작업공간 루트 경로.

            예:
                "/workspace/project"

        query:
            각 줄에서 찾을 문자열. 대소문자는 구분하지 않는다.
            빈 문자열은 허용하지 않는다.

            예:
                "validate_token"
                "class UserService"

        path:
            재귀 검색을 시작할 workspace_root 기준 디렉토리 경로.
            기본값 "."은 workspace 전체를 의미한다.

            예:
                "."
                "src/services"

        file_pattern:
            검색할 파일 경로에 적용할 선택적 glob 패턴.
            생략하면 지원되는 모든 텍스트 파일을 검색한다.

            예:
                "*.py"
                "*.yaml"
                "src/**/*.py"

        max_results:
            반환할 최대 매치 줄 수. 기본값은 100이다.
            이 값을 넘는 첫 매치를 확인하면 탐색을 중단한다.

            예:
                50

    Returns:
        다음 형식의 dictionary를 반환한다.

        {
            "query": "validate_token",
            "results": [
                {
                    "path": "src/auth_service.py",
                    "line": 87,
                    "content": "def validate_token(token):"
                }
            ],
            "truncated": False
        }

        한 줄에 query가 여러 번 있어도 결과는 해당 줄 하나만 반환한다.
        content에서는 줄 끝 개행 문자만 제거한다.

    Raises:
        FileNotFoundError:
            workspace_root 또는 path가 존재하지 않을 때 발생한다.

        NotADirectoryError:
            workspace_root 또는 path가 디렉토리가 아닐 때 발생한다.

        PermissionError:
            workspace 밖에 접근하거나 검색 경로를 읽을 권한이 없을 때
            발생한다.

        ValueError:
            query나 file_pattern이 비었거나 max_results가 1보다 작을 때
            발생한다.

    Agent 사용 지침:
        - 함수명, 설정 키, 오류 문구 등 정확한 문자열을 찾을 때 사용해라.
        - 결과가 많으면 file_pattern이나 path로 범위를 좁혀라.
        - 실제 구현 문맥이 더 필요하면 결과의 path와 line으로 read_file을
          호출해라.
    """
    if not query:
        raise ValueError(
            "query는 비어 있을 수 없습니다."
        )

    if file_pattern is not None and not file_pattern:
        raise ValueError(
            "file_pattern은 비어 있을 수 없습니다."
        )

    if max_results < 1:
        raise ValueError(
            "max_results는 1 이상이어야 합니다."
        )

    root, target = _resolve_path(
        workspace_root=workspace_root,
        path=path,
    )

    if not target.is_dir():
        raise NotADirectoryError(
            f"검색 시작 경로가 디렉토리가 아닙니다: {path}"
        )

    normalized_query = query.casefold()
    results: list[dict[str, Any]] = []
    truncated = False

    def handle_walk_error(error: OSError) -> None:
        raise PermissionError(
            f"검색 경로를 읽을 권한이 없습니다: {path}"
        ) from error

    for current_path, directory_names, file_names in os.walk(
        target,
        topdown=True,
        onerror=handle_walk_error,
        followlinks=False,
    ):
        current = Path(current_path)
        allowed_directories: list[str] = []

        for directory_name in sorted(
            directory_names,
            key=str.casefold,
        ):
            directory = current / directory_name

            if directory.is_symlink():
                continue

            if _should_ignore(
                directory,
                include_hidden=False,
            ):
                continue

            allowed_directories.append(directory_name)

        directory_names[:] = allowed_directories

        for file_name in sorted(
            file_names,
            key=str.casefold,
        ):
            file_path = current / file_name

            if file_path.is_symlink():
                continue

            if _should_ignore(
                file_path,
                include_hidden=False,
            ):
                continue

            if not file_path.is_file():
                continue

            relative_path = _relative_path(
                root,
                file_path,
            )

            if (
                file_pattern is not None
                and not Path(relative_path).match(
                    file_pattern
                )
            ):
                continue

            if file_path.suffix.lower() == ".ipynb":
                continue

            remaining_results = (
                max_results - len(results)
            )
            file_results: list[dict[str, Any]] = []
            file_has_extra_match = False
            excluded_file = False

            try:
                with file_path.open(mode="rb") as file:
                    for line_number, raw_line in enumerate(
                        file,
                        start=1,
                    ):
                        line = raw_line.decode(
                            "utf-8",
                            errors="strict",
                        )

                        if any(
                            (
                                ord(character) < 32
                                and character not in "\t\n\r\f"
                            )
                            or ord(character) == 127
                            for character in line
                        ):
                            excluded_file = True
                            break

                        if normalized_query not in line.casefold():
                            continue

                        if len(file_results) < remaining_results:
                            file_results.append(
                                {
                                    "path": relative_path,
                                    "line": line_number,
                                    "content": line.rstrip(
                                        "\r\n"
                                    ),
                                }
                            )
                        else:
                            file_has_extra_match = True
            except UnicodeDecodeError:
                excluded_file = True
            except PermissionError as exc:
                raise PermissionError(
                    "파일을 읽을 권한이 없습니다: "
                    f"{relative_path}"
                ) from exc

            if excluded_file:
                continue

            results.extend(file_results)

            if file_has_extra_match:
                truncated = True
                break

        if truncated:
            break

    return {
        "query": query,
        "results": results,
        "truncated": truncated,
    }


def get_project_tree(
    workspace_root: str,
    path: str = ".",
    max_depth: int = 4,
    include_hidden: bool = False,
    max_entries: int = 500,
) -> dict[str, Any]:
    """
    지정한 작업공간의 디렉토리 구조를 재귀적으로 조회합니다.

    처음 보는 프로젝트의 전체 구조를 파악하거나,
    사용자 요청과 관련된 코드가 어느 디렉토리에 있을지 탐색할 때 사용합니다.

    실제 소스 코드의 내용이나 함수 동작을 확인하는 툴이 아닙니다.
    관련 파일 위치를 찾은 이후에는 `read_file` 또는 `search_code`를 사용하세요.

    Args:
        workspace_root:
            현재 작업 대상 프로젝트 또는 작업공간의 루트 경로입니다.

            모든 탐색은 이 디렉토리 내부로 제한됩니다.
            MCP 클라이언트가 현재 작업공간의 실제 경로를 전달해야 합니다.

            예:
                "/home/user/project"
                "/workspace/my_project"

        path:
            프로젝트 트리 탐색을 시작할 workspace_root 기준 상대 경로입니다.

            일반적으로 프로젝트 전체 구조를 확인할 때는 "."을 사용합니다.
            특정 하위 영역만 확인하고 싶은 경우 해당 디렉토리를 지정할 수 있습니다.

            예:
                "."
                "src"
                "src/backend"

        max_depth:
            path를 기준으로 재귀 탐색할 최대 디렉토리 깊이입니다.

            기본값은 4입니다.

            예:
                max_depth=1
                    지정한 디렉토리의 바로 아래 항목만 확인합니다.

                max_depth=2
                    바로 아래 디렉토리의 내부까지 확인합니다.

                max_depth=4
                    일반적인 프로젝트 구조 파악에 적합합니다.

            너무 큰 값을 사용하면 반환 결과가 커져
            Agent 컨텍스트를 과도하게 사용할 수 있습니다.

        include_hidden:
            이름이 "."으로 시작하는 숨김 파일과 디렉토리를
            결과에 포함할지 여부입니다.

            기본값은 False입니다.

            단, .git, .venv 등 DEFAULT_IGNORE_DIRS에 등록된
            고노이즈 디렉토리는 항상 제외합니다.

        max_entries:
            프로젝트 트리 전체에 포함할 최대 파일 및 디렉토리 개수입니다.

            기본값은 500입니다.

            디렉토리별 제한이 아니라 전체 재귀 탐색 결과에 대한 제한입니다.

            탐색 중 이 값을 초과하면 나머지 탐색을 중단하고
            반환 결과의 `truncated`를 True로 설정합니다.

    Returns:
        다음 형식의 dictionary를 반환합니다.

        {
            "path": ".",
            "tree": {
                "name": ".",
                "path": ".",
                "type": "directory",
                "children": [
                    {
                        "name": "src",
                        "path": "src",
                        "type": "directory",
                        "children": [
                            {
                                "name": "main.py",
                                "path": "src/main.py",
                                "type": "file",
                                "size": 4210
                            }
                        ]
                    }
                ]
            },
            "total_entries": 12,
            "truncated": False
        }

        path:
            탐색을 시작한 workspace 기준 상대 경로입니다.

        tree:
            파일과 디렉토리 구조를 표현하는 중첩 객체입니다.

        name:
            파일 또는 디렉토리 이름입니다.

        path:
            workspace 기준 상대 경로입니다.

        type:
            "file" 또는 "directory"입니다.

        children:
            해당 디렉토리 바로 아래의 파일 및 디렉토리입니다.

        size:
            파일 크기(byte)입니다.
            디렉토리에는 포함되지 않습니다.

        total_entries:
            tree에 포함된 전체 파일 및 디렉토리 개수입니다.
            최상위 root 노드는 개수에 포함하지 않습니다.

        truncated:
            max_entries 제한 때문에 전체 구조 중 일부가
            생략되었는지 여부입니다.

    Raises:
        FileNotFoundError:
            workspace_root 또는 지정한 path가 존재하지 않는 경우 발생합니다.

        NotADirectoryError:
            workspace_root 또는 지정한 path가 디렉토리가 아닌 경우 발생합니다.

        PermissionError:
            workspace_root 바깥의 경로에 접근하려는 경우 발생합니다.

        ValueError:
            max_depth 또는 max_entries가 1보다 작은 경우 발생합니다.

    Agent 사용 지침:
        - 처음 보는 프로젝트의 구조를 파악할 때 우선 사용하세요.
        - 관련 디렉토리를 찾았다면 list_files로 범위를 좁힐 수 있습니다.
        - 파일명이나 디렉토리명만 보고 코드 동작을 판단하지 마세요.
        - 실제 구현은 read_file 또는 search_code로 확인하세요.
        - truncated가 True이면 max_entries를 무조건 늘리지 말고,
          관련 디렉토리를 path로 지정하여 범위를 좁혀 다시 탐색하세요.
    """
    if max_depth < 1:
        raise ValueError(
            "max_depth는 1 이상이어야 합니다."
        )

    if max_entries < 1:
        raise ValueError(
            "max_entries는 1 이상이어야 합니다."
        )

    root, target = _resolve_path(
        workspace_root=workspace_root,
        path=path,
    )

    if not target.is_dir():
        raise NotADirectoryError(
            f"디렉토리가 아닙니다: {path}"
        )

    total_entries = 0
    truncated = False

    def build_tree(
        current: Path,
        depth: int,
    ) -> dict[str, Any]:
        nonlocal total_entries, truncated

        node: dict[str, Any] = {
            "name": (
                "."
                if current == root
                else current.name
            ),
            "path": _relative_path(root, current),
            "type": "directory",
            "children": [],
        }

        if depth >= max_depth:
            return node

        try:
            children = sorted(
                current.iterdir(),
                key=lambda item: (
                    not item.is_dir(),
                    item.name.lower(),
                ),
            )
        except PermissionError:
            node["access_error"] = True
            return node

        for child in children:
            if _should_ignore(
                child,
                include_hidden=include_hidden,
            ):
                continue

            if total_entries >= max_entries:
                truncated = True
                break

            total_entries += 1

            if child.is_dir():
                child_node = build_tree(
                    current=child,
                    depth=depth + 1,
                )
            else:
                child_node: dict[str, Any] = {
                    "name": child.name,
                    "path": _relative_path(root, child),
                    "type": "file",
                }

                try:
                    child_node["size"] = child.stat().st_size
                except OSError:
                    child_node["size"] = None

            node["children"].append(child_node)

            if truncated:
                break

        return node

    tree = build_tree(
        current=target,
        depth=0,
    )

    return {
        "path": _relative_path(root, target),
        "tree": tree,
        "total_entries": total_entries,
        "truncated": truncated,
    }
