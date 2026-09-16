"use strict";

(function () {
    // 모델규격 정제용 3열 표본. UI와 서버 요청은 호출자가 담당한다.
    async function readNormalizationSample() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported(
            "ExcelApi", "1.1"
        )) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }

        return await Excel.run(async function (context) {
            var range = context.workbook.getSelectedRange();
            var sheet = range.worksheet;

            // 전체 셀 내용은 로드하지 않는다.
            range.load(
                "address,rowCount,columnCount,rowIndex,columnIndex"
            );
            sheet.load("id,name");

            await context.sync();

            if (range.columnCount !== 3) {
                throw new Error(
                    "서로 붙어 있는 세 열을 선택하세요."
                );
            }

            if (range.rowCount < 2 || range.rowCount > 400001) {
                throw new Error(
                    "머리글과 데이터 1~400,000행을 선택하세요. " +
                    "열 전체 선택은 지원하지 않습니다."
                );
            }

            // 머리글 1행 + 데이터 최대 20행만 읽는다.
            var count = Math.min(range.rowCount, 21);
            var sampleRange = range.getCell(0, 0)
                .getResizedRange(count - 1, 2);

            sampleRange.load("text");
            await context.sync();

            var rows = sampleRange.text;

            if (rows.some(function (row) {
                return row.some(function (cell) {
                    return cell.length > 1000;
                });
            })) {
                throw new Error(
                    "표본에 1,000자를 넘는 셀이 있습니다. " +
                    "선택한 열이 맞는지 확인하세요."
                );
            }

            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                headers: rows[0],
                samples: rows.slice(1).map(function (row) {
                    return { cells: row };
                })
            };
        });
    }
  
    async function writeNormalizationSample(preview) {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }

        if (!preview.rows.length || preview.rows.length > 20) {
            throw new Error("표본 1~20행만 출력할 수 있습니다.");
        }

        // 같은 결과를 재시도할 때도 같은 이름을 사용한다.
        var sheetName = "정제_" +
            preview.preview_id.replace(/-/g, "").slice(0, 24);

        return await Excel.run(async function (context) {
            var sheets = context.workbook.worksheets;
            sheets.load("items/name");
            await context.sync();

            if (sheets.items.some(function (sheet) {
                return sheet.name === sheetName;
            })) {
                throw new Error(
                    sheetName + " 시트가 이미 있습니다. " +
                    "이전 출력 결과를 확인하세요."
                );
            }

            var values = [[
                "원본 행 번호",
                "거래품명",
                "신고품명",
                "원본 모델규격",
                "정제 모델규격"
            ]].concat(preview.rows.map(function (row) {
                return [
                    row.excel_row,
                    row.trade_name,
                    row.declared_name,
                    row.original_model_spec,
                    row.normalized_model_spec
                ];
            }));

            var sheet = sheets.add(sheetName);
            var range = sheet.getRange("A1:E" + values.length);

            // 모델규격의 앞자리 0 등을 보존하도록 먼저 텍스트 서식을 설정한다.
            range.numberFormat = values.map(function () {
                return ["@", "@", "@", "@", "@"];
            });
            await context.sync();

            range.values = values.map(function (row) {
                return row.map(function (value) {
                    // 문자열은 Excel의 텍스트 접두어로 입력한다.
                    // =, +, -로 시작하는 모델규격도 수식으로 실행하지 않는다.
                    return typeof value === "string" && value !== ""
                        ? "'" + value
                        : value;
                });
            });

            sheet.getRange("A1:E1").format.font.bold = true;

            preview.rows.forEach(function (row, index) {
                if (row.changed) {
                    var excelRow = index + 2;
                    sheet.getRange("A" + excelRow + ":E" + excelRow)
                        .format.fill.color = "#FFF2CC";
                }
            });

            range.format.columnWidth = 130;
            range.format.wrapText = true;
            sheet.activate();
            await context.sync();

            return {
                sheet_name: sheetName,
                row_count: preview.rows.length
            };
        });
    }
  
    async function readCounterpartyRows() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }
        return await Excel.run(async function (context) {
            var range = context.workbook.getSelectedRange();
            var sheet = range.worksheet;
            range.load("address,rowCount,columnCount,rowIndex,columnIndex");
            sheet.load("id,name");
            await context.sync();
            if (range.columnCount !== 3) {
                throw new Error("머리글을 포함한 서로 붙어 있는 세 열을 선택하세요.");
            }
            if (range.rowCount < 2) {
                throw new Error("머리글과 데이터 한 행 이상을 선택하세요.");
            }
            var rows = [];
            // 청크 크기는 총행 수 제한이 아니다.
            for (var offset = 0; offset < range.rowCount; offset += 1000) {
                var size = Math.min(1000, range.rowCount - offset);
                var data = range.getCell(offset, 0).getResizedRange(size - 1, 2);
                data.load("text");
                await context.sync();
                if (data.text.some(function (row) {
                    return row.some(function (cell) { return cell.length > 1000; });
                })) {
                    throw new Error("선택한 데이터에 1,000자를 넘는 셀이 있습니다.");
                }
                rows.push.apply(rows, data.text);
            }
            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                headers: rows[0],
                rows: rows.slice(1).map(function (row) { return { cells: row }; })
            };
        });
    }


    window.excelBridge = {
        readNormalizationSample: readNormalizationSample,
        writeNormalizationSample: writeNormalizationSample,
        readCounterpartyRows: readCounterpartyRows
    };
})();
