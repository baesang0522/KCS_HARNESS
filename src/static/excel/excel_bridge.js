"use strict";

(function () {
    // 모델규격 정제용 3열 표본. UI와 서버 요청은 호출자가 담당한다.
    async function readNormalizationRows() {
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
                throw new Error("서로 붙어 있는 세 열을 선택하세요.");
            }

            if (range.rowCount < 2 || range.rowCount > 400001) {
                throw new Error(
                    "머리글과 데이터 1~400,000행을 선택하세요. " +
                    "열 전체 선택은 지원하지 않습니다."
                );
            }

            var rows = [];

            for (var offset = 0; offset < range.rowCount; offset += 200) {
                var size = Math.min(200, range.rowCount - offset);
                var chunk = range.getCell(offset, 0)
                    .getResizedRange(size - 1, 2);

                chunk.load("text");
                await context.sync();

                if (chunk.text.some(function (row) {
                    return row.some(function (cell) {
                        return cell.length > 1000;
                    });
                })) {
                    throw new Error(
                        "선택 영역에 1,000자를 넘는 셀이 있습니다."
                    );
                }

                rows.push.apply(rows, chunk.text);
            }

            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                headers: rows[0],
                rows: rows.slice(1).map(function (row) {
                    return { cells: row };
                })
            };
        });
    }
  
    async function writeNormalizationPreview(preview) {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }

        if (
            !preview.rows.length ||
            preview.rows.length > 400000 ||
            preview.row_count !== preview.rows.length
        ) {
            throw new Error("승인된 전체 결과의 행 수가 올바르지 않습니다.");
        }

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
                    "이전 출력 또는 부분 출력 결과를 확인하세요."
                );
            }

            var sheet = sheets.add(sheetName);

            try {
                sheet.getRange("A1:E1").values = [[
                    "원본 행 번호",
                    "거래품명",
                    "신고품명",
                    "원본 모델규격",
                    "정제 모델규격"
                ]];
                sheet.getRange("A1:E1").format.font.bold = true;
                await context.sync();

                for (
                    var offset = 0;
                    offset < preview.rows.length;
                    offset += 200
                ) {
                    var rows = preview.rows.slice(offset, offset + 200);
                    var start = offset + 2;
                    var end = start + rows.length - 1;
                    var range = sheet.getRange("A" + start + ":E" + end);

                    range.numberFormat = rows.map(function () {
                        return ["@", "@", "@", "@", "@"];
                    });
                    await context.sync();

                    range.values = rows.map(function (row) {
                        return [
                            row.excel_row,
                            row.trade_name,
                            row.declared_name,
                            row.original_model_spec,
                            row.normalized_model_spec
                        ].map(function (value) {
                            return typeof value === "string" && value !== ""
                                ? "'" + value
                                : value;
                        });
                    });

                    rows.forEach(function (row, index) {
                        if (row.changed) {
                            var outputRow = start + index;
                            sheet.getRange(
                                "A" + outputRow + ":E" + outputRow
                            ).format.fill.color = "#FFF2CC";
                        }
                    });

                    range.format.columnWidth = 130;
                    range.format.wrapText = true;
                    await context.sync();
                }

                sheet.activate();
                await context.sync();
            } catch (error) {
                throw new Error(
                    sheetName + " 시트에 일부 결과가 남아 있을 수 있습니다. " +
                    "해당 시트를 확인하세요. " + error.message
                );
            }

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

    async function writeCounterpartyPreview(preview) {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }
        if (!preview.rows.length) {
            throw new Error("승인한 후보가 없습니다.");
        }

        var sheetName = "거래처_" +
            preview.preview_id.replace(/-/g, "").slice(0, 24);
        return await Excel.run(async function (context) {
            var sheets = context.workbook.worksheets;
            sheets.load("items/name");
            await context.sync();
            if (sheets.items.some(function (sheet) { return sheet.name === sheetName; })) {
                throw new Error(sheetName + " 시트가 이미 있습니다. 이전 출력 결과를 확인하세요.");
            }

            var values = [[
                "원본 행 번호", "국가코드", "상호명", "기존 해외거래처부호",
                "대표 해외거래처부호", "변경 여부", "후보 그룹"
            ]].concat(preview.rows.map(function (row) {
                return [
                    row.excel_row, row.country_code, row.company_name,
                    row.original_party_code, row.representative_party_code,
                    row.changed ? "변경" : "유지", row.group_id
                ];
            }));
            var sheet = sheets.add(sheetName);
            var range = sheet.getRange("A1:G" + values.length);
            range.numberFormat = values.map(function () {
                return ["@", "@", "@", "@", "@", "@", "@"];
            });
            await context.sync();
            range.values = values.map(function (row) {
                return row.map(function (value) {
                    return typeof value === "string" && value !== "" ? "'" + value : value;
                });
            });
            sheet.getRange("A1:G1").format.font.bold = true;
            preview.rows.forEach(function (row, index) {
                if (row.changed) {
                    sheet.getRange("A" + (index + 2) + ":G" + (index + 2))
                        .format.fill.color = "#FFF2CC";
                }
            });
            range.format.columnWidth = 130;
            range.format.wrapText = true;
            sheet.activate();
            await context.sync();
            return {sheet_name: sheetName, row_count: preview.rows.length};
        });
    }


    window.excelBridge = {
        readNormalizationRows: readNormalizationRows,
        writeNormalizationPreview: writeNormalizationPreview,
        readCounterpartyRows: readCounterpartyRows,
        writeCounterpartyPreview: writeCounterpartyPreview
    };
})();
