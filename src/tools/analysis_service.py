from typing import Annotated, Any, Literal

from pydantic import Field

from utils.dataframe_utils import (
    dataframe_to_records,
    load_table_dataframe,
    select_dataframe_columns,
)
from utils.statistics_utils import summarize_dataframe


MAX_PREVIEW_ROWS = 20


def inspect_table(
    workspace_root: str,
    path: str,
    sheet_name: str | None = None,
) -> dict[str, Any]:
    """
    Parquet, XLSX, CSV 테이블의 구조와 컬럼 통계를 조회한다.

    실제 row나 샘플은 반환하지 않는다. 반환 크기는 행 수가 아닌
    컬럼 수에 비례한다.

    Args:
        workspace_root:
            파일 접근을 허용할 작업공간 루트 경로.

        path:
            workspace_root 기준 파일 경로.
            .parquet, .xlsx, .csv를 지원한다.

        sheet_name:
            XLSX 시트 이름. 생략하면 첫 번째 시트를 사용한다.
            Parquet과 CSV에는 지정할 수 없다.

    Returns:
        다음 형식의 dictionary를 반환한다.

        {
            "row_count": 100,
            "column_count": 2,
            "columns": [
                {
                    "name": "amount",
                    "dtype": "float64",
                    "null_count": 3,
                    "null_ratio": 0.03,
                    "n_unique": 72
                }
            ]
        }

        n_unique는 null을 제외한 고유값 개수다.
        빈 테이블의 null_ratio는 0.0이다.

    Raises:
        FileNotFoundError:
            workspace_root 또는 파일이 존재하지 않을 때 발생한다.

        NotADirectoryError:
            workspace_root가 디렉토리가 아닐 때 발생한다.

        IsADirectoryError:
            path가 파일이 아닌 디렉토리일 때 발생한다.

        PermissionError:
            workspace_root 바깥에 접근하려 할 때 발생한다.

        ValueError:
            파일 형식이나 sheet_name이 잘못됐을 때 발생한다.

    Agent 사용 지침:
        - 분석 전에 테이블 구조를 파악할 때 사용해라.
        - XLSX가 아닌 파일에는 sheet_name을 전달하지 마라.
    """
    dataframe = load_table_dataframe(
        workspace_root=workspace_root,
        path=path,
        sheet_name=sheet_name,
    )

    return summarize_dataframe(dataframe)


def preview_rows(
    workspace_root: str,
    path: str,
    sheet_name: str | None = None,
    columns: list[str] | None = None,
    n: Annotated[int, Field(ge=1, le=20)] = 20,
    mode: Literal["head", "tail", "random"] = "head",
) -> dict[str, Any]:
    """
    Parquet, XLSX, CSV 테이블의 실제 값을 일부 조회한다.

    컬럼 이름만으로 의미를 판단하기 어려울 때 사용한다. 최대 20개 행만
    반환하며 같은 데이터에 대한 random 결과는 재현 가능하다.

    Args:
        workspace_root:
            파일 접근을 허용할 작업공간 루트 경로.

        path:
            workspace_root 기준 파일 경로.
            .parquet, .xlsx, .csv를 지원한다.

        sheet_name:
            XLSX 시트 이름. 생략하면 첫 번째 시트를 사용한다.
            Parquet과 CSV에는 지정할 수 없다.

        columns:
            반환할 컬럼 이름. 생략하면 전체 컬럼을 반환한다.

        n:
            반환할 최대 행 수. 1 이상 20 이하여야 한다.

        mode:
            행 선택 방식. head, tail, random 중 하나다.

    Returns:
        다음 형식의 dictionary를 반환한다.

        {
            "columns": ["id", "amount"],
            "rows": [
                {"id": 1, "amount": 10.5}
            ],
            "returned_row_count": 1
        }

    Raises:
        FileNotFoundError:
            workspace_root 또는 파일이 없을 때 발생한다.

        PermissionError:
            workspace_root 바깥에 접근하려 할 때 발생한다.

        ValueError:
            컬럼, n, mode, 파일 형식 또는 sheet_name이 잘못됐을 때 발생한다.

    Agent 사용 지침:
        - inspect_table로 구조를 확인한 뒤 값의 의미가 불명확할 때 사용해라.
        - 필요한 컬럼만 지정하고 가능한 한 작은 n을 사용해라.
    """
    if isinstance(n, bool) or n < 1 or n > MAX_PREVIEW_ROWS:
        raise ValueError(
            f"n은 1 이상 {MAX_PREVIEW_ROWS} 이하여야 합니다."
        )

    if mode not in {"head", "tail", "random"}:
        raise ValueError(
            "mode는 head, tail, random 중 하나여야 합니다."
        )

    dataframe = load_table_dataframe(
        workspace_root=workspace_root,
        path=path,
        sheet_name=sheet_name,
    )
    selected = select_dataframe_columns(
        dataframe=dataframe,
        columns=columns,
    )

    if mode == "head":
        preview = selected.head(n)
    elif mode == "tail":
        preview = selected.tail(n)
    else:
        preview = selected.sample(
            n=min(n, len(selected)),
            random_state=0,
        )

    rows = dataframe_to_records(preview)

    return {
        "columns": list(selected.columns),
        "rows": rows,
        "returned_row_count": len(rows),
    }
