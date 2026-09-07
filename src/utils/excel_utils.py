from pathlib import Path

import pandas as pd


def read_excel_dataframe(
    path: Path,
    sheet_name: str | None = None,
) -> pd.DataFrame:
    """
    XLSX 파일의 지정한 시트를 pandas DataFrame으로 읽는다.

    Args:
        path:
            검증된 XLSX 절대 경로.

        sheet_name:
            시트 이름. 생략하면 첫 번째 시트를 사용한다.

    Returns:
        선택한 시트의 DataFrame을 반환한다.

    Raises:
        ValueError:
            시트가 없거나 sheet_name이 존재하지 않을 때 발생한다.

        OSError:
            XLSX 파일을 읽을 수 없을 때 발생한다.
    """
    with pd.ExcelFile(
        path,
        engine="openpyxl",
    ) as workbook:
        if not workbook.sheet_names:
            raise ValueError(
                "XLSX 파일에 조회할 수 있는 시트가 없습니다."
            )

        selected_sheet = (
            sheet_name
            if sheet_name is not None
            else workbook.sheet_names[0]
        )

        if selected_sheet not in workbook.sheet_names:
            raise ValueError(
                f"XLSX 시트가 존재하지 않습니다: {selected_sheet}"
            )

        return pd.read_excel(
            workbook,
            sheet_name=selected_sheet,
        )
