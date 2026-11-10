"use strict";
(function () {
    window.readRecommendation = async function (workspace, columnIds, expected, progress, check) {
        check = check || function () {};
        check();
        if (!workspace || !expected) throw new Error(window.errorMessages.WORKSPACE_REQUIRED);
        if (workspace.worksheet_id !== expected.worksheet_id ||
            String(workspace.table_id) !== String(expected.table_id)) {
            throw new Error("작업 표가 바뀌었습니다. 새 조언 요청을 보내세요.");
        }
        if (!Array.isArray(columnIds) || !columnIds.length || columnIds.length > 200 ||
            columnIds.some(function (id) { return typeof id !== "string"; }) ||
            new Set(columnIds).size !== columnIds.length) {
            throw new Error("분석 대상 열이 올바르지 않습니다.");
        }
        columnIds.forEach(function (id) {
            var current = workspace.columns.find(function (column) { return String(column.column_id) === id; });
            var original = expected.columns.find(function (column) { return String(column.column_id) === id; });
            if (!current || !original || current.header !== original.header || current.role !== original.role ||
                (current.description || "") !== (original.description || "")) {
                throw new Error("분석 대상 열이나 설명이 바뀌었습니다. 새 조언 요청을 보내세요.");
            }
        });
        var full = await Excel.run(async function (context) {
            var info = await window.workspaceTable.layout(context, workspace);
            return {row_start: info.body.rowIndex, row_count: info.body.rowCount, stamp: info.stamp};
        });
        if (workspace.task_type === "model_normalization") {
            var grouped = await window.recommendationSheet.readModelAdvice(workspace, full, columnIds, progress, check);
            check();
            return Object.assign({
                worksheet_id: workspace.worksheet_id, table_id: String(workspace.table_id),
                row_start: full.row_start, row_count: full.row_count, column_ids: columnIds
            }, grouped);
        }
        var snapshot = await window.operationsSheet.read(workspace, full, columnIds, progress, check);
        check();
        if (snapshot.stamp !== full.stamp || snapshot.rows.length !== full.row_count) {
            throw new Error("읽는 동안 작업 표가 바뀌었습니다. 다시 요청하세요.");
        }
        return {
            worksheet_id: workspace.worksheet_id, table_id: String(workspace.table_id),
            row_start: full.row_start, row_count: full.row_count, column_ids: columnIds,
            rows: snapshot.rows.map(function (row) { return {excel_row: row.excel_row, values: row.values}; })
        };
    };
})();
