"use strict";
(function () {
    var batchSize = 1000;
    async function layout(context, workspace) {
        var sheet = context.workbook.worksheets.getItem(workspace.worksheet_id);
        var table = sheet.tables.getItem(workspace.table_id);
        var body = table.getDataBodyRange();
        sheet.load("name");
        body.load("rowIndex,columnIndex,rowCount,columnCount");
        table.columns.load("items/id,items/name,items/index");
        await context.sync();
        var columns = table.columns.items.map(function (column) {
            return {column_id: column.id, header: column.name, column_index: body.columnIndex + column.index};
        });
        var identity = columns.find(function (column) { return column.column_id === workspace.source_row_column_id; });
        if (!identity) throw new Error("원본 행 번호 열이 없습니다. 작업 시트를 확인하세요.");
        return {sheet: sheet, table: table, body: body, columns: columns, identity: identity,
            stamp: JSON.stringify([body.rowIndex, body.columnIndex, body.rowCount, columns])};
    }
    async function chunk(context, info, start, count, columns) {
        var ranges = columns.map(function (column) {
            var range = info.sheet.getRangeByIndexes(start, column.column_index, count, 1);
            range.load("text"); return range;
        });
        var ids = info.sheet.getRangeByIndexes(start, info.identity.column_index, count, 1);
        ids.load("values");
        await context.sync();
        return ids.values.map(function (row, index) {
            return {excel_row: start + index + 1, identity: row[0],
                values: ranges.map(function (range) { return range.text[index][0]; })};
        });
    }
    function selectedColumns(info, ids) {
        return ids.map(function (id) {
            var column = info.columns.find(function (item) { return String(item.column_id) === String(id); });
            if (!column || column.column_id === info.identity.column_id) throw new Error("대상 열이 없습니다. 범위를 다시 선택하세요.");
            return column;
        });
    }
    window.workspaceTable = {batchSize: batchSize, layout: layout, chunk: chunk, selectedColumns: selectedColumns};
})();
