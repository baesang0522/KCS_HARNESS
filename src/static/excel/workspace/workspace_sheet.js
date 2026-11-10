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

    function selectionBounds(ranges) {
        if (!ranges.length) throw new Error("데이터가 있는 열을 선택하세요.");
        var first = ranges[0];
        if (ranges.some(function (range) {
            return range.rowIndex !== first.rowIndex || range.rowCount !== first.rowCount;
        })) throw new Error("떨어진 열은 같은 시작 행과 끝 행으로 선택하세요.");
        var indexes = new Set();
        ranges.forEach(function (range) {
            for (var index = range.columnIndex; index < range.columnIndex + range.columnCount; index++) {
                indexes.add(index);
            }
        });
        return {row_start: first.rowIndex, row_count: first.rowCount,
            column_indexes: Array.from(indexes).sort(function (a, b) { return a - b; })};
    }

    async function readSource() {
        requireExcel("1.9");
        return Excel.run(async function (context) {
            var selected = context.workbook.getSelectedRanges();
            var sheet = selected.worksheet;
            selected.areas.load("items/rowIndex,items/rowCount,items/columnIndex,items/columnCount");
            sheet.load("id,name");
            await context.sync();
            var bounds = selectionBounds(selected.areas.items);
            // 영역별 끝의 빈칸 때문에 같은 행의 값이 서로 밀리지 않도록 행 구간을 공유한다.
            var usedRanges = selected.areas.items.map(function (area) {
                var used = area.getUsedRangeOrNullObject(true);
                used.load("rowIndex,columnIndex,rowCount,columnCount");
                return used;
            });
            await context.sync();
            var used = usedRanges.filter(function (range) { return !range.isNullObject; });
            if (!used.length) throw new Error("선택한 범위에 데이터가 없습니다.");
            var rowStart = Math.min.apply(null, used.map(function (r) { return r.rowIndex; }));
            var rowEnd = Math.max.apply(null, used.map(function (r) { return r.rowIndex + r.rowCount; }));
            var columnStart = Math.min.apply(null, used.map(function (r) { return r.columnIndex; }));
            var columnEnd = Math.max.apply(null, used.map(function (r) { return r.columnIndex + r.columnCount; }));
            var indexes = bounds.column_indexes.filter(function (index) { return index >= columnStart && index < columnEnd; });
            if (rowEnd - rowStart < 2) throw new Error("머리글과 데이터가 포함된 범위를 선택하세요.");
            if (rowEnd - rowStart > 400001) throw new Error("데이터는 최대 400,000행까지 선택할 수 있습니다.");
            if (indexes.length > 200) throw new Error("원본 범위는 최대 200열을 선택하세요.");
            var sampleCount = Math.min(20, rowEnd - rowStart - 1);
            var ranges = indexes.map(function (index) {
                var range = sheet.getRangeByIndexes(rowStart, index, rowEnd - rowStart, 1);
                var sample = sheet.getRangeByIndexes(rowStart, index, sampleCount + 1, 1);
                range.load("address"); sample.load("text");
                return {range: range, sample: sample};
            });
            await context.sync();
            return {
                worksheet_id: sheet.id, sheet_name: sheet.name,
                address: ranges.map(function (item) { return item.range.address; }).join(", "),
                row_start: rowStart, column_start: indexes[0], column_indexes: indexes,
                row_count: rowEnd - rowStart, column_count: indexes.length,
                data_row_count: rowEnd - rowStart - 1,
                headers: ranges.map(function (item) { return item.sample.text[0][0]; }),
                sample_rows: Array.from({length: sampleCount}, function (_, row) {
                    return {cells: ranges.map(function (item) { return item.sample.text[row + 1][0]; })};
                })
            };
        });
    }

    async function readWorkspaceTarget(workspace, activate) {
        requireExcel("1.9");
        return Excel.run(async function (context) {
            var table = activate ? context.workbook.worksheets
                .getItem(workspace.worksheet_id).tables.getItem(workspace.table_id) : null;
            var selected = activate ? table.getDataBodyRange() : context.workbook.getSelectedRanges();
            var sheet = selected.worksheet;
            sheet.load("id,name");
            if (activate) selected.load("rowIndex,columnIndex,rowCount,columnCount");
            else selected.areas.load("items/rowIndex,items/rowCount,items/columnIndex,items/columnCount");
            await context.sync();
            if (sheet.id !== workspace.worksheet_id) return null;
            if (!table) table = sheet.tables.getItem(workspace.table_id);
            var body = table.getDataBodyRange();
            body.load("rowIndex,columnIndex,rowCount,columnCount");
            table.columns.load("items/id,items/name,items/index");
            await context.sync();
            var ranges = (activate ? [selected] : selected.areas.items).map(function (range) {
                var rowStart = Math.max(range.rowIndex, body.rowIndex);
                var rowEnd = Math.min(range.rowIndex + range.rowCount, body.rowIndex + body.rowCount);
                var columnStart = Math.max(range.columnIndex, body.columnIndex);
                var columnEnd = Math.min(range.columnIndex + range.columnCount, body.columnIndex + body.columnCount);
                return {rowIndex: rowStart, rowCount: rowEnd - rowStart,
                    columnIndex: columnStart, columnCount: columnEnd - columnStart};
            }).filter(function (range) { return range.rowCount > 0 && range.columnCount > 0; });
            if (!ranges.length) throw new Error("작업 시트에서 데이터가 있는 열이나 행을 선택하세요.");
            var bounds = selectionBounds(ranges);
            if (bounds.row_count > 400000) throw new Error("작업 대상은 최대 400,000행까지 선택할 수 있습니다.");
            var columns = table.columns.items.filter(function (column) {
                return String(column.id) !== String(workspace.source_row_column_id) &&
                    bounds.column_indexes.includes(body.columnIndex + column.index);
            }).map(function (column) {
                var known = workspace.columns.find(function (item) { return String(item.column_id) === String(column.id); });
                return Object.assign({role: "reference", description: ""}, known || {}, {
                    column_id: column.id, column_index: body.columnIndex + column.index, header: column.name
                });
            }).sort(function (a, b) { return a.column_index - b.column_index; });
            if (!columns.length) throw new Error("원본 행 번호 이외의 작업 열을 선택하세요.");
            var targets = columns.map(function (column) {
                var range = sheet.getRangeByIndexes(bounds.row_start, column.column_index, bounds.row_count, 1);
                range.load("address"); return range;
            });
            if (activate) { sheet.activate(); body.select(); }
            await context.sync();
            return {
                worksheet_id: workspace.worksheet_id, sheet_name: sheet.name,
                address: targets.map(function (range) { return range.address; }).join(", "),
                row_start: bounds.row_start, row_count: bounds.row_count,
                column_count: columns.length, columns: columns
            };
        });
    }

    window.workspaceSheet = {
        requireExcel: requireExcel,
        readSource: readSource,
        readWorkspaceTarget: readWorkspaceTarget
    };
})();
