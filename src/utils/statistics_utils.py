from typing import Any

import pandas as pd


def summarize_dataframe(
    dataframe: pd.DataFrame,
) -> dict[str, Any]:
    """
    DataFrame의 행·열 개수와 컬럼별 기본 통계를 생성한다.

    Args:
        dataframe:
            통계를 계산할 pandas DataFrame.

    Returns:
        row_count, column_count와 각 컬럼의 name, dtype, null_count,
        null_ratio, n_unique를 반환한다. 실제 row는 반환하지 않는다.
    """
    row_count = int(dataframe.shape[0])
    column_count = int(dataframe.shape[1])
    columns: list[dict[str, Any]] = []

    for position, column_name in enumerate(dataframe.columns):
        series = dataframe.iloc[:, position]
        null_count = int(series.isna().sum())
        null_ratio = (
            float(null_count / row_count)
            if row_count > 0
            else 0.0
        )

        columns.append(
            {
                "name": str(column_name),
                "dtype": str(series.dtype),
                "null_count": null_count,
                "null_ratio": null_ratio,
                "n_unique": int(
                    series.nunique(dropna=True)
                ),
            }
        )

    return {
        "row_count": row_count,
        "column_count": column_count,
        "columns": columns,
    }
