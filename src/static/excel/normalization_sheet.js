"use strict";

(function () {
    function requireExcel(version) {
        if (
            typeof Excel === "undefined" ||
            typeof Office === "undefined"
        ) {
            throw new Error("Excel 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported(
            "ExcelApi",
            version || "1.4"
        )) {
            throw new Error("ExcelApi " + (version || "1.4") + " 이상 지원이 필요합니다.");
        }
    }

    async function readSource() {
        requireExcel();

        return Excel.run(async function (context) {
            var selected = context.workbook.getSelectedRange();
            var sheet = selected.worksheet;

            // 선택 범위 안에서 실제 값이 있는 영역만 확인한다.
            // 열 전체를 선택해도 빈 행 전체를 읽지 않는다.
            var used = selected.getUsedRangeOrNullObject(true);

            sheet.load("id,name");
            used.load(
                "address,rowIndex,columnIndex,rowCount,columnCount"
            );

            await context.sync();

            if (used.isNullObject) {
                throw new Error("선택한 범위에 데이터가 없습니다.");
            }

            if (used.rowCount < 2) {
                throw new Error(
                    "머리글과 데이터가 포함된 범위를 선택하세요."
                );
            }

            // 기존 모델규격 기능의 데이터 행 제한을 유지한다.
            if (used.rowCount > 400001) {
                throw new Error(
                    "데이터는 최대 400,000행까지 선택할 수 있습니다."
                );
            }

            // 실제 값이 있는 영역의 첫 행을 머리글로 사용한다.
            var headerRange = used.getRow(0);
            var sampleCount = Math.min(20, used.rowCount - 1);
            var sampleRange = used.getCell(1, 0).getResizedRange(
                sampleCount - 1,
                used.columnCount - 1
            );

            headerRange.load("text");
            sampleRange.load("text");

            await context.sync();

            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: used.address,

                // Excel API의 위치는 0부터 시작한다.
                row_start: used.rowIndex,
                column_start: used.columnIndex,

                // row_count에는 머리글 한 행이 포함된다.
                row_count: used.rowCount,
                column_count: used.columnCount,
                data_row_count: used.rowCount - 1,

                headers: headerRange.text[0],
                sample_rows: sampleRange.text.map(function (cells) {
                    return { cells: cells };
                })
            };
        });
    }

    async function readWorkspaceTarget(workspace, activate) {
        requireExcel();
        return Excel.run(async function (context) {
            var table = activate ? context.workbook.worksheets
                .getItem(workspace.worksheet_id).tables.getItem(workspace.table_id) : null;
            var selected = activate ? table.getDataBodyRange() : context.workbook.getSelectedRange();
            var selectedSheet = selected.worksheet;
            selectedSheet.load("id");
            await context.sync();
            // 다른 시트라면 호출자가 새 원본 범위 선택으로 처리한다.
            if (selectedSheet.id !== workspace.worksheet_id) return null;

            var sheet = selectedSheet;
            if (!table) table = sheet.tables.getItem(workspace.table_id);
            var used = sheet.getUsedRange(true);
            var header = table.getHeaderRowRange();
            selected.load("rowIndex,columnIndex,rowCount,columnCount");
            used.load("rowIndex,columnIndex,rowCount,columnCount");
            header.load("rowIndex,columnIndex");
            sheet.load("name");
            table.columns.load("items/id,items/name,items/index");
            await context.sync();
            var rowStart = Math.max(selected.rowIndex, header.rowIndex + 1);
            var rowEnd = Math.min(selected.rowIndex + selected.rowCount, used.rowIndex + used.rowCount);
            var columnStart = Math.max(selected.columnIndex, used.columnIndex);
            var columnEnd = Math.min(
                selected.columnIndex + selected.columnCount, used.columnIndex + used.columnCount
            );
            if (rowEnd <= rowStart || columnEnd <= columnStart) {
                throw new Error("작업 시트에서 데이터가 있는 열이나 행을 선택하세요.");
            }
            if (rowEnd - rowStart > 400000) {
                throw new Error("작업 대상은 최대 400,000행까지 선택할 수 있습니다.");
            }
            var range = sheet.getRangeByIndexes(rowStart, columnStart, rowEnd - rowStart, columnEnd - columnStart);
            var labels = sheet.getRangeByIndexes(header.rowIndex, columnStart, 1, columnEnd - columnStart);
            range.load("address");
            labels.load("text");
            await context.sync();
            var columns = labels.text[0].reduce(function (result, name, index) {
                var absoluteIndex = columnStart + index;
                var column = table.columns.items.find(function (item) {
                    return header.columnIndex + item.index === absoluteIndex;
                });
                if (column && column.id === workspace.source_row_column_id) return result;
                var known = column && workspace.columns.find(function (item) {
                    return item.column_id === column.id;
                });
                result.push(Object.assign({}, known || {}, {
                    column_id: column ? column.id : null,
                    column_index: absoluteIndex,
                    header: name,
                    description: known ? known.description : ""
                }));
                return result;
            }, []);
            if (!columns.length) throw new Error("원본 행 번호 이외의 작업 열을 선택하세요.");
            if (activate) {
                sheet.activate();
                range.select();
                await context.sync();
            }
            return {
                worksheet_id: workspace.worksheet_id, sheet_name: sheet.name,
                address: range.address, row_start: rowStart, row_count: rowEnd - rowStart,
                column_count: columns.length, columns: columns
            };
        });
    }

    window.normalizationSheet = {
        requireExcel: requireExcel,
        readSource: readSource,
        readWorkspaceTarget: readWorkspaceTarget
    };
})();
