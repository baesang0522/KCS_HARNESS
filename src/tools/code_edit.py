# 보안상 agent가 아닌 harness가 workspace_root를 제공함
import codecs
import hashlib
import json
import os
import shutil
import stat
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.investigation_service import (
    DEFAULT_IGNORE_DIRS,
    _resolve_path,
)


MAX_WRITE_CHARS = 1_000_000
ALLOWED_CONTROL_CHARACTERS = "\t\n\r\f"
SNAPSHOT_ROOT_ENV = "AGENT_SNAPSHOT_ROOT"


def _contains_disallowed_control_character(
    content: str,
) -> bool:
    """텍스트에 허용하지 않는 제어문자가 있는지 확인한다."""
    return any(
        (
            ord(character) < 32
            and character not in ALLOWED_CONTROL_CHARACTERS
        )
        or ord(character) == 127
        for character in content
    )


def _validate_existing_text_file(path: Path) -> None:
    """기존 파일이 UTF-8 텍스트 파일인지 전체 내용을 확인한다."""
    decoder = codecs.getincrementaldecoder("utf-8")(
        errors="strict"
    )

    try:
        with path.open(mode="rb") as file:
            while chunk := file.read(8192):
                content = decoder.decode(chunk)

                if _contains_disallowed_control_character(
                    content
                ):
                    raise ValueError(
                        "binary 파일은 덮어쓸 수 없습니다."
                    )

            remaining_content = decoder.decode(
                b"",
                final=True,
            )

            if _contains_disallowed_control_character(
                remaining_content
            ):
                raise ValueError(
                    "binary 파일은 덮어쓸 수 없습니다."
                )
    except UnicodeDecodeError as exc:
        raise ValueError(
            "비 UTF-8 파일은 덮어쓸 수 없습니다."
        ) from exc


def _resolve_write_path(
    workspace_root: str,
    path: str,
) -> tuple[Path, Path, str]:
    """새 파일도 처리할 수 있도록 안전한 workspace 쓰기 경로를 만든다."""
    if not path or not path.strip():
        raise ValueError(
            "path는 비어 있을 수 없습니다."
        )

    relative_path = Path(path)

    if relative_path.is_absolute():
        raise PermissionError(
            "절대경로에는 파일을 쓸 수 없습니다."
        )

    if relative_path == Path("."):
        raise IsADirectoryError(
            "workspace_root에는 파일을 쓸 수 없습니다."
        )

    if ".." in relative_path.parts:
        raise PermissionError(
            "'..'이 포함된 경로에는 파일을 쓸 수 없습니다."
        )

    protected_directory = next(
        (
            part
            for part in relative_path.parts
            if part in DEFAULT_IGNORE_DIRS
        ),
        None,
    )

    if protected_directory is not None:
        raise PermissionError(
            "보호된 디렉토리에는 파일을 쓸 수 없습니다: "
            f"{protected_directory}"
        )

    root, _ = _resolve_path(
        workspace_root=workspace_root,
        path=".",
    )
    unresolved_target = root / relative_path
    target = unresolved_target.resolve(strict=False)

    if target != root and root not in target.parents:
        raise PermissionError(
            "작업공간 외부 경로에는 파일을 쓸 수 없습니다: "
            f"{path}"
        )

    current_path = root

    for part in relative_path.parts:
        if part in {"", "."}:
            continue

        current_path /= part

        if current_path.is_symlink():
            raise PermissionError(
                "symbolic link 경로에는 파일을 쓸 수 없습니다: "
                f"{path}"
            )

    normalized_path = target.relative_to(root).as_posix()

    return root, target, normalized_path


def _write_atomically(
    target: Path,
    content: bytes,
    existing_mode: int | None,
) -> None:
    """같은 디렉토리의 임시 파일을 이용해 내용을 원자적으로 기록한다."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=target.parent,
    )
    temporary_path = Path(temporary_name)

    try:
        with os.fdopen(descriptor, mode="wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())

        os.chmod(
            temporary_path,
            existing_mode
            if existing_mode is not None
            else 0o644,
        )

        if existing_mode is None:
            os.link(temporary_path, target)
        else:
            os.replace(temporary_path, target)
    finally:
        temporary_path.unlink(missing_ok=True)


def _file_state(
    path: Path,
) -> tuple[int, int, int, int, int, int]:
    """외부 파일 변경을 확인할 수 있는 stat 상태를 반환한다."""
    file_stat = path.stat(follow_symlinks=False)

    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
        stat.S_IMODE(file_stat.st_mode),
    )


def _read_patch_target(
    path: Path,
) -> tuple[bytes, str, tuple[int, int, int, int, int, int]]:
    """수정 대상의 byte, UTF-8 텍스트, 파일 상태를 안전하게 읽는다."""
    if path.is_symlink():
        raise PermissionError(
            f"symbolic link 파일은 수정할 수 없습니다: {path.name}"
        )

    if not path.exists():
        raise FileNotFoundError(
            f"수정할 파일이 존재하지 않습니다: {path.name}"
        )

    if not path.is_file():
        raise ValueError(
            f"일반 텍스트 파일만 수정할 수 있습니다: {path.name}"
        )

    before_state = _file_state(path)
    original_bytes = path.read_bytes()
    after_state = _file_state(path)

    if before_state != after_state:
        raise RuntimeError(
            "파일을 읽는 중 외부 변경이 감지되었습니다."
        )

    try:
        original_text = original_bytes.decode(
            "utf-8",
            errors="strict",
        )
    except UnicodeDecodeError as exc:
        raise ValueError(
            "비 UTF-8 파일은 수정할 수 없습니다."
        ) from exc

    if _contains_disallowed_control_character(
        original_text
    ):
        raise ValueError(
            "binary 파일은 수정할 수 없습니다."
        )

    return original_bytes, original_text, after_state


def _assert_target_unchanged(
    path: Path,
    expected_bytes: bytes,
    expected_state: tuple[int, int, int, int, int, int],
) -> None:
    """처음 읽은 뒤 대상 파일이 바뀌지 않았는지 확인한다."""
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(
            "수정 중 대상 파일이 교체되었습니다."
        )

    before_state = _file_state(path)
    current_bytes = path.read_bytes()
    after_state = _file_state(path)

    if (
        before_state != after_state
        or after_state != expected_state
        or current_bytes != expected_bytes
    ):
        raise RuntimeError(
            "수정 중 파일의 외부 변경이 감지되었습니다."
        )


def _find_occurrences(
    content: str,
    text: str,
) -> list[int]:
    """겹쳐 시작하는 일치까지 포함해 모든 시작 위치를 찾는다."""
    positions: list[int] = []
    start = 0

    while True:
        position = content.find(text, start)

        if position == -1:
            return positions

        positions.append(position)
        start = position + 1


def _prepare_patch_edits(
    original_text: str,
    edits: list[dict[str, str]],
) -> list[tuple[int, int, str]]:
    """모든 edit를 원본 기준으로 검증하고 적용 범위를 반환한다."""
    if not edits:
        raise ValueError(
            "edits는 한 개 이상이어야 합니다."
        )

    prepared_edits: list[tuple[int, int, str]] = []
    seen_edits: set[tuple[str, str]] = set()

    for index, edit in enumerate(edits, start=1):
        if not isinstance(edit, dict):
            raise ValueError(
                f"edit는 dictionary여야 합니다: {index}번째 edit"
            )

        if set(edit) != {"old_text", "new_text"}:
            raise ValueError(
                "각 edit에는 old_text와 new_text만 있어야 합니다: "
                f"{index}번째 edit"
            )

        old_text = edit["old_text"]
        new_text = edit["new_text"]

        if not isinstance(old_text, str) or not isinstance(
            new_text,
            str,
        ):
            raise ValueError(
                "old_text와 new_text는 문자열이어야 합니다: "
                f"{index}번째 edit"
            )

        if not old_text:
            raise ValueError(
                f"old_text는 비어 있을 수 없습니다: {index}번째 edit"
            )

        if old_text == new_text:
            raise ValueError(
                "old_text와 new_text는 달라야 합니다: "
                f"{index}번째 edit"
            )

        edit_key = (old_text, new_text)

        if edit_key in seen_edits:
            raise ValueError(
                f"중복 edit는 허용하지 않습니다: {index}번째 edit"
            )

        seen_edits.add(edit_key)

        if _contains_disallowed_control_character(
            new_text
        ):
            raise ValueError(
                "new_text에 허용되지 않는 제어문자가 있습니다: "
                f"{index}번째 edit"
            )

        positions = _find_occurrences(
            original_text,
            old_text,
        )

        if len(positions) != 1:
            raise ValueError(
                "old_text는 수정 전 원본에서 정확히 한 번 일치해야 합니다: "
                f"{index}번째 edit, 일치 {len(positions)}건"
            )

        start = positions[0]
        prepared_edits.append(
            (
                start,
                start + len(old_text),
                new_text,
            )
        )

    prepared_edits.sort(key=lambda edit: edit[0])

    for previous, current in zip(
        prepared_edits,
        prepared_edits[1:],
    ):
        if current[0] < previous[1]:
            raise ValueError(
                "서로 겹치는 edit는 허용하지 않습니다."
            )

    return prepared_edits


def _resolve_snapshot_root(
    workspace_root: Path,
) -> Path:
    """환경변수에서 workspace와 분리된 snapshot 저장소를 확인한다."""
    configured_root = os.environ.get(
        SNAPSHOT_ROOT_ENV
    )

    if not configured_root:
        raise RuntimeError(
            f"{SNAPSHOT_ROOT_ENV} 환경변수가 필요합니다."
        )

    configured_path = Path(
        configured_root
    ).expanduser()

    if not configured_path.is_absolute():
        raise ValueError(
            f"{SNAPSHOT_ROOT_ENV}는 절대경로여야 합니다."
        )

    if configured_path.is_symlink():
        raise PermissionError(
            "snapshot root는 symbolic link일 수 없습니다."
        )

    snapshot_root = configured_path.resolve(
        strict=False
    )

    if (
        snapshot_root == workspace_root
        or workspace_root in snapshot_root.parents
        or snapshot_root in workspace_root.parents
    ):
        raise PermissionError(
            "snapshot root는 workspace와 분리된 경로여야 합니다."
        )

    snapshot_root.mkdir(
        mode=0o700,
        parents=True,
        exist_ok=True,
    )

    if not snapshot_root.is_dir():
        raise NotADirectoryError(
            "snapshot root가 디렉토리가 아닙니다."
        )

    os.chmod(snapshot_root, 0o700)

    return snapshot_root


def _write_private_file(
    path: Path,
    content: bytes,
) -> None:
    """새 파일을 다른 사용자가 읽을 수 없는 권한으로 기록한다."""
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )

    try:
        with os.fdopen(descriptor, mode="wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise

    os.chmod(path, 0o600)


def _remove_snapshot_directory(
    snapshot_directory: Path,
) -> None:
    """실패한 snapshot 디렉토리를 남기지 않고 제거한다."""
    if snapshot_directory.exists():
        shutil.rmtree(snapshot_directory)


def _create_snapshot(
    snapshot_root: Path,
    task_id: str,
    relative_path: str,
    original_bytes: bytes,
    original_sha256: str,
    file_mode: int,
) -> tuple[str, Path]:
    """원본 byte와 metadata를 고유 snapshot 디렉토리에 저장한다."""
    snapshot_id = uuid.uuid4().hex
    snapshot_directory = snapshot_root / snapshot_id

    try:
        snapshot_directory.mkdir(
            mode=0o700,
        )
        os.chmod(snapshot_directory, 0o700)

        _write_private_file(
            snapshot_directory / "original.bin",
            original_bytes,
        )

        metadata = {
            "snapshot_id": snapshot_id,
            "task_id": task_id,
            "path": relative_path,
            "created_at": datetime.now(
                timezone.utc
            ).isoformat().replace("+00:00", "Z"),
            "before_sha256": original_sha256,
            "file_mode": f"0o{file_mode:o}",
        }
        metadata_bytes = json.dumps(
            metadata,
            ensure_ascii=False,
            indent=2,
        ).encode("utf-8")

        _write_private_file(
            snapshot_directory / "metadata.json",
            metadata_bytes,
        )
    except Exception:
        _remove_snapshot_directory(
            snapshot_directory
        )
        raise

    return snapshot_id, snapshot_directory


def _prepare_patch_file(
    target: Path,
    content: bytes,
    file_mode: int,
) -> Path:
    """원자적 교체에 사용할 임시 파일을 대상 디렉토리에 준비한다."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=".tmp",
        dir=target.parent,
    )
    temporary_path = Path(temporary_name)

    try:
        with os.fdopen(descriptor, mode="wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())

        os.chmod(temporary_path, file_mode)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    return temporary_path


def write_file(
    workspace_root: str,
    path: str,
    content: str,
    overwrite: bool = False,
    create_parent_dirs: bool = False,
) -> dict[str, Any]:
    """
    workspace 내부에 UTF-8 텍스트 파일을 새로 만들거나 전체 교체한다.

    기존 파일 전체 교체에는 overwrite=True가 필요하다. 부분 수정에는
    사용하지 않으며 입력받은 content를 개행 변환 없이 그대로 기록한다.

    Args:
        workspace_root:
            파일 쓰기를 허용할 작업공간 루트 경로. 모든 쓰기는 이 경로
            내부로 제한한다. 예: "/workspace/project"

        path:
            생성하거나 전체 교체할 파일의 workspace_root 기준 상대경로.
            절대경로, '..', symbolic link 경로는 허용하지 않는다.
            예: "src/services/user_service.py"

        content:
            파일에 기록할 전체 문자열. UTF-8로 인코딩하며 개행 문자를
            포함한 입력 내용을 그대로 기록한다. 최대 1,000,000자까지
            허용한다.

        overwrite:
            기존 파일 전체를 교체할지 여부. 기본값은 False다.
            False인데 대상 파일이 이미 존재하면 FileExistsError가 발생한다.

        create_parent_dirs:
            존재하지 않는 부모 디렉토리를 함께 만들지 여부.
            기본값은 False다. False인데 부모가 없으면 FileNotFoundError가
            발생한다.

    Returns:
        {
            "path": "src/services/user_service.py",
            "operation": "created",
            "chars_written": 120,
            "bytes_written": 128
        }

        operation은 created, overwritten, unchanged 중 하나다. 실제로 기록한
        문자 수와 UTF-8 byte 수만 반환하고 파일 내용은 반환하지 않는다.

    Raises:
        FileNotFoundError:
            workspace_root가 존재하지 않거나 create_parent_dirs가 False인
            상태에서 부모 디렉토리가 존재하지 않을 때 발생한다.

        FileExistsError:
            overwrite가 False인데 대상 파일이 이미 존재할 때 발생한다.

        IsADirectoryError:
            path가 파일이 아닌 디렉토리를 가리킬 때 발생한다.

        NotADirectoryError:
            workspace_root가 디렉토리가 아닐 때 발생한다.

        PermissionError:
            workspace 외부, 절대경로, '..', symbolic link, 보호된 디렉토리에
            쓰려고 하거나 파일 쓰기 권한이 없을 때 발생한다.

        ValueError:
            path가 비었거나 content가 제한을 초과하거나 제어문자를 포함하거나,
            .ipynb, binary, 비 UTF-8 파일을 처리하려 할 때 발생한다.

        OSError:
            디렉토리 또는 파일을 생성하거나 원자적으로 교체하지 못했을 때
            발생한다.

    Agent 사용 지침:
        - 새 파일을 만들거나 기존 파일 전체를 다시 작성할 때만 사용해라.
        - 기존 파일을 교체하기 전에 read_file로 현재 내용을 확인해라.
        - 기존 파일을 교체할 때만 overwrite=True를 전달해라.
        - 일부 코드만 바꾸려면 부분 수정 전용 Tool을 사용해라.
        - 부모 디렉토리도 새로 만들어야 할 때만 create_parent_dirs=True를
          전달해라.
    """
    if not isinstance(content, str):
        raise TypeError(
            "content는 문자열이어야 합니다."
        )

    if len(content) > MAX_WRITE_CHARS:
        raise ValueError(
            "content는 최대 "
            f"{MAX_WRITE_CHARS:,}자까지 쓸 수 있습니다."
        )

    if _contains_disallowed_control_character(content):
        raise ValueError(
            "content에 허용되지 않는 제어문자가 포함되어 있습니다."
        )

    try:
        encoded_content = content.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(
            "content를 UTF-8로 인코딩할 수 없습니다."
        ) from exc

    _, target, normalized_path = _resolve_write_path(
        workspace_root=workspace_root,
        path=path,
    )

    if target.suffix.lower() == ".ipynb":
        raise ValueError(
            ".ipynb 파일은 write_file로 쓸 수 없습니다."
        )

    if target.exists() and target.is_dir():
        raise IsADirectoryError(
            f"파일 대신 디렉토리가 지정되었습니다: {path}"
        )

    parent = target.parent

    if parent.exists() and not parent.is_dir():
        raise NotADirectoryError(
            f"부모 경로가 디렉토리가 아닙니다: {path}"
        )

    if not parent.exists():
        if not create_parent_dirs:
            raise FileNotFoundError(
                f"부모 디렉토리가 존재하지 않습니다: {path}"
            )

        try:
            parent.mkdir(
                parents=True,
                exist_ok=True,
            )
        except PermissionError as exc:
            raise PermissionError(
                f"부모 디렉토리를 만들 권한이 없습니다: {path}"
            ) from exc

    try:
        if parent.resolve(strict=True) != parent:
            raise PermissionError(
                "symbolic link 부모 경로에는 파일을 쓸 수 없습니다: "
                f"{path}"
            )
    except RuntimeError as exc:
        raise PermissionError(
            f"안전하지 않은 부모 경로에는 파일을 쓸 수 없습니다: {path}"
        ) from exc

    if target.is_symlink():
        raise PermissionError(
            "symbolic link 경로에는 파일을 쓸 수 없습니다: "
            f"{path}"
        )

    target_exists = target.exists()
    existing_mode: int | None = None

    if target_exists:
        if not target.is_file():
            raise ValueError(
                f"일반 텍스트 파일만 덮어쓸 수 있습니다: {path}"
            )

        if not overwrite:
            raise FileExistsError(
                f"파일이 이미 존재합니다: {normalized_path}"
            )

        _validate_existing_text_file(target)
        existing_mode = stat.S_IMODE(
            target.stat().st_mode
        )

        if (
            target.stat().st_size == len(encoded_content)
            and target.read_bytes() == encoded_content
        ):
            return {
                "path": normalized_path,
                "operation": "unchanged",
                "chars_written": 0,
                "bytes_written": 0,
            }

    try:
        _write_atomically(
            target=target,
            content=encoded_content,
            existing_mode=existing_mode,
        )
    except PermissionError as exc:
        raise PermissionError(
            f"파일을 쓸 권한이 없습니다: {normalized_path}"
        ) from exc

    return {
        "path": normalized_path,
        "operation": (
            "overwritten"
            if target_exists
            else "created"
        ),
        "chars_written": len(content),
        "bytes_written": len(encoded_content),
    }


def apply_patch(
    workspace_root: str,
    task_id: str,
    path: str,
    edits: list[dict[str, str]],
) -> dict[str, Any]:
    """
    기존 UTF-8 일반 텍스트 파일의 정확히 일치하는 부분만 수정한다.

    모든 edit를 수정 전 원본에서 먼저 검증하고 뒤쪽 위치부터 적용한다.
    하나라도 유효하지 않으면 파일과 snapshot을 변경하지 않는다.

    Args:
        workspace_root:
            Harness가 주입하는 작업공간 루트 경로. Agent가 입력하지 않는다.

        task_id:
            Harness가 주입하는 현재 작업 식별자. metadata 기록에만 사용하며
            snapshot 경로에는 사용하지 않는다. Agent가 입력하지 않는다.

        path:
            수정할 기존 파일의 workspace_root 기준 상대경로.
            예: "src/service.py"

        edits:
            old_text와 new_text 문자열을 가진 edit 목록. old_text는 수정 전
            원본에 정확히 한 번 있어야 한다. new_text가 빈 문자열이면 해당
            범위를 삭제한다.

            예:
                [
                    {
                        "old_text": "return old_value",
                        "new_text": "return new_value"
                    }
                ]

    Returns:
        {
            "path": "src/service.py",
            "operation": "patched",
            "edits_applied": 1,
            "snapshot_id": "불투명한 고유 ID",
            "before_sha256": "...",
            "after_sha256": "...",
            "bytes_written": 1320
        }

    Raises:
        FileNotFoundError:
            workspace_root 또는 수정 대상 파일이 없을 때 발생한다.

        PermissionError:
            workspace 외부, 절대경로, '..', 숨김·보호 경로 또는 symbolic
            link를 수정하려 할 때 발생한다.

        ValueError:
            파일 형식이나 edit가 계약에 맞지 않거나 일치 건수·범위 검증에
            실패할 때 발생한다.

        RuntimeError:
            snapshot 설정이 없거나 수정 중 외부 파일 변경을 감지할 때
            발생한다.

        OSError:
            snapshot 또는 임시 파일을 기록하거나 원자적으로 교체하지 못할 때
            발생한다.

    Agent 사용 지침:
        - 기존 일반 텍스트 파일의 일부만 바꿀 때 사용해라.
        - path와 edits만 작성하고 workspace_root와 task_id는 입력하지 마라.
        - 새 파일은 write_file로 생성해라.
        - old_text에는 원본에서 한 번만 나타나는 충분한 문맥을 포함해라.
    """
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError(
            "task_id는 비어 있을 수 없습니다."
        )

    relative_path = Path(path)

    if any(
        part.startswith(".") and part not in {"", "."}
        for part in relative_path.parts
    ):
        raise PermissionError(
            "숨김 경로의 파일은 수정할 수 없습니다."
        )

    root, target, normalized_path = _resolve_write_path(
        workspace_root=workspace_root,
        path=path,
    )

    if target.suffix.lower() == ".ipynb":
        raise ValueError(
            ".ipynb 파일은 apply_patch로 수정할 수 없습니다."
        )

    original_bytes, original_text, original_state = (
        _read_patch_target(target)
    )
    prepared_edits = _prepare_patch_edits(
        original_text=original_text,
        edits=edits,
    )
    patched_text = original_text

    for start, end, new_text in reversed(
        prepared_edits
    ):
        patched_text = (
            patched_text[:start]
            + new_text
            + patched_text[end:]
        )

    try:
        patched_bytes = patched_text.encode(
            "utf-8",
            errors="strict",
        )
    except UnicodeEncodeError as exc:
        raise ValueError(
            "수정 결과를 UTF-8로 인코딩할 수 없습니다."
        ) from exc

    if patched_bytes == original_bytes:
        raise ValueError(
            "edit 적용 결과가 원본과 같습니다."
        )

    before_sha256 = hashlib.sha256(
        original_bytes
    ).hexdigest()
    after_sha256 = hashlib.sha256(
        patched_bytes
    ).hexdigest()
    file_mode = original_state[-1]
    snapshot_root = _resolve_snapshot_root(root)
    temporary_path = _prepare_patch_file(
        target=target,
        content=patched_bytes,
        file_mode=file_mode,
    )
    snapshot_directory: Path | None = None
    patch_committed = False

    try:
        _assert_target_unchanged(
            path=target,
            expected_bytes=original_bytes,
            expected_state=original_state,
        )
        snapshot_id, snapshot_directory = _create_snapshot(
            snapshot_root=snapshot_root,
            task_id=task_id,
            relative_path=normalized_path,
            original_bytes=original_bytes,
            original_sha256=before_sha256,
            file_mode=file_mode,
        )
        _assert_target_unchanged(
            path=target,
            expected_bytes=original_bytes,
            expected_state=original_state,
        )
        os.replace(temporary_path, target)
        patch_committed = True
    finally:
        temporary_path.unlink(missing_ok=True)

        if (
            snapshot_directory is not None
            and not patch_committed
        ):
            _remove_snapshot_directory(
                snapshot_directory
            )

    return {
        "path": normalized_path,
        "operation": "patched",
        "edits_applied": len(prepared_edits),
        "snapshot_id": snapshot_id,
        "before_sha256": before_sha256,
        "after_sha256": after_sha256,
        "bytes_written": len(patched_bytes),
    }
