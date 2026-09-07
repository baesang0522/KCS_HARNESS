# 보안상 agent가 아닌 harness가 실행 컨텍스트를 제공함
import re
import uuid
from pathlib import Path
from typing import Any

from tools.code_edit import (
    MAX_WRITE_CHARS,
    _contains_disallowed_control_character,
    _resolve_write_path,
)


SOURCE_HASH_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


def write_jupyter_code_cell(
    workspace_root: str,
    task_id: str,
    notebook_path: str,
    mode: str,
    source: str,
    target_cell_id: str | None = None,
    expected_source_hash: str | None = None,
) -> dict[str, Any]:
    """
    JupyterLab의 live Notebook model에 적용할 코드 셀 변경 action을 만든다.

    Notebook 파일을 직접 수정하지 않는다. Harness는 반환된 action을
    JupyterLab Bridge에 전달하고, Bridge가 활성 Notebook model에서 셀을
    검증한 뒤 undo 가능한 transaction으로 변경하고 저장해야 한다.

    Args:
        workspace_root:
            Harness가 주입하는 작업공간 루트. Agent가 입력하지 않는다.

        task_id:
            Harness가 주입하는 작업 식별자. 새 셀 metadata에 기록한다.
            Agent가 입력하지 않는다.

        notebook_path:
            Harness가 주입하는 활성 Notebook의 workspace 기준 상대경로.
            `.ipynb` 기존 파일만 허용한다. Agent가 입력하지 않는다.

        mode:
            `revise` 또는 `create`. revise는 지정한 기존 코드 셀 아래에
            수정 셀을 만들고, create는 활성 셀 상태에 따라 작성하거나
            바로 아래에 새 코드 셀을 만든다.

        source:
            새 셀에 기록할 실행 가능한 전체 함수·클래스 또는 전체 코드
            블록. 비어 있거나 1,000,000자를 넘을 수 없다.

        target_cell_id:
            revise에서 기준으로 사용할 기존 셀 ID. create에서는 사용하지
            않는다.

        expected_source_hash:
            revise 대상의 현재 source를 UTF-8 byte로 계산한 선택적 SHA-256.
            Bridge가 live model의 hash와 비교한다.

    Returns:
        Harness가 JupyterLab Bridge로 전달할 다음 action을 반환한다.

        {
            "notebook_path": "notebooks/analysis.ipynb",
            "operation": "jupyter_code_cell_action",
            "executed": False,
            "action": {
                "action_id": "불투명한 고유 ID",
                "type": "write_jupyter_code_cell",
                "task_id": "Harness task ID",
                "notebook_path": "notebooks/analysis.ipynb",
                "mode": "revise",
                "source": "...",
                "target_cell_id": "cell-id",
                "expected_source_hash": "..."
            }
        }

    Raises:
        FileNotFoundError:
            workspace_root 또는 Notebook 파일이 없을 때 발생한다.

        PermissionError:
            절대경로, `..`, workspace 밖 또는 symbolic link 경로를 전달할 때
            발생한다.

        ValueError:
            파일 확장자, mode, source, target_cell_id 또는 source hash가
            계약에 맞지 않을 때 발생한다.

    Agent 사용 지침:
        - mode와 source만 판단해서 작성해라.
        - revise에서는 target_cell_id와 필요시 expected_source_hash를 작성해라.
        - 함수 일부가 아닌 실행 가능한 전체 코드 블록을 source로 전달해라.
        - 셀 검색·삭제·이동·실행 목적으로 사용하지 마라.
    """
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError(
            "task_id는 비어 있을 수 없습니다."
        )

    if mode not in {"revise", "create"}:
        raise ValueError(
            "mode는 'revise' 또는 'create'여야 합니다."
        )

    if not isinstance(source, str) or not source.strip():
        raise ValueError(
            "source는 비어 있을 수 없습니다."
        )

    if len(source) > MAX_WRITE_CHARS:
        raise ValueError(
            "source는 최대 "
            f"{MAX_WRITE_CHARS:,}자까지 허용합니다."
        )

    if _contains_disallowed_control_character(source):
        raise ValueError(
            "source에 허용되지 않는 제어문자가 포함되어 있습니다."
        )

    if mode == "revise":
        if (
            not isinstance(target_cell_id, str)
            or not target_cell_id.strip()
        ):
            raise ValueError(
                "revise mode에는 target_cell_id가 필요합니다."
            )
    elif target_cell_id is not None:
        raise ValueError(
            "create mode에는 target_cell_id를 전달할 수 없습니다."
        )

    if expected_source_hash is not None:
        if mode != "revise":
            raise ValueError(
                "expected_source_hash는 revise mode에서만 사용할 수 있습니다."
            )

        if not SOURCE_HASH_PATTERN.fullmatch(
            expected_source_hash
        ):
            raise ValueError(
                "expected_source_hash는 64자리 SHA-256 hex여야 합니다."
            )

        expected_source_hash = (
            expected_source_hash.lower()
        )

    _, target, normalized_path = _resolve_write_path(
        workspace_root=workspace_root,
        path=notebook_path,
    )

    if target.suffix.lower() != ".ipynb":
        raise ValueError(
            ".ipynb Notebook만 사용할 수 있습니다."
        )

    if not target.exists():
        raise FileNotFoundError(
            f"Notebook이 존재하지 않습니다: {notebook_path}"
        )

    if not target.is_file():
        raise ValueError(
            f"Notebook 경로가 파일이 아닙니다: {notebook_path}"
        )

    action = {
        "action_id": uuid.uuid4().hex,
        "type": "write_jupyter_code_cell",
        "task_id": task_id,
        "notebook_path": normalized_path,
        "mode": mode,
        "source": source,
        "target_cell_id": target_cell_id,
        "expected_source_hash": expected_source_hash,
    }

    return {
        "notebook_path": normalized_path,
        "operation": "jupyter_code_cell_action",
        "executed": False,
        "action": action,
    }
