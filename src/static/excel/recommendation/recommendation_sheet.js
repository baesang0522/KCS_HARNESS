"use strict";
(function () {
    var table = window.workspaceTable;
    var batchSize = table.batchSize, layout = table.layout;
    var chunk = table.chunk, selectedColumns = table.selectedColumns;
    async function readModelAdvice(workspace, target, ids, progress, cancelled) {
        window.workspaceSheet.requireExcel("1.9");
        return Excel.run(async function (context) {
            var info = await layout(context, workspace);
            if (info.stamp !== target.stamp) throw new Error("작업 표가 바뀌었습니다. 다시 요청하세요.");
            if (target.row_count < 1 || target.row_count > 400000 || target.row_start < info.body.rowIndex ||
                target.row_start + target.row_count > info.body.rowIndex + info.body.rowCount) {
                throw new Error("현재 행 범위를 다시 선택하세요.");
            }
            var roles = ["declared_name", "trade_name", "model_spec"];
            var groupIds = roles.map(function (role) {
                var matches = workspace.columns.filter(function (column) { return column.role === role; });
                if (matches.length !== 1 || ids.indexOf(String(matches[0].column_id)) < 0) {
                    throw new Error(window.errorMessages.ADVICE_GROUP_COLUMNS_REQUIRED);
                }
                return String(matches[0].column_id);
            });
            var keys = selectedColumns(info, groupIds);
            var columns = selectedColumns(info, ids);
            var groups = new Map();
            for (var offset = 0; offset < target.row_count; offset += batchSize) {
                cancelled();
                var count = Math.min(batchSize, target.row_count - offset);
                var part = await chunk(context, info, target.row_start + offset, count, keys);
                part.forEach(function (row) {
                    var key = JSON.stringify(row.values.map(function (value) { return value.toUpperCase(); }));
                    var group = groups.get(key);
                    if (group) group.count++;
                    else groups.set(key, {key: key, excel_row: row.excel_row, count: 1});
                });
                progress("전체 조합 빈도 집계", offset + count, target.row_count);
            }
            cancelled();
            var selected = Array.from(groups.values()).sort(function (a, b) {
                return b.count - a.count || a.excel_row - b.excel_row;
            }).slice(0, 100);
            var totalCombinations = groups.size;
            groups.clear();
            var rows = [];
            for (var index = 0; index < selected.length; index++) {
                cancelled();
                var group = selected[index];
                var row = (await chunk(context, info, group.excel_row - 1, 1, columns))[0];
                var values = row.values.map(function (value) { return value.toUpperCase(); });
                var key = JSON.stringify(groupIds.map(function (id) { return values[ids.indexOf(id)]; }));
                if (key !== group.key) throw new Error("집계 중 대표 행의 값이 바뀌었습니다. 다시 요청하세요.");
                rows.push({excel_row: row.excel_row, values: values, count: group.count});
                progress("상위 조합의 참고 열 읽기", index + 1, selected.length);
            }
            cancelled();
            if ((await layout(context, workspace)).stamp !== info.stamp) throw new Error("읽는 동안 표 구성이 바뀌었습니다.");
            return {rows: rows, selection: {
                mode: "uppercase_top_combinations", group_column_ids: groupIds,
                total_rows: target.row_count, total_combinations: totalCombinations,
                selected_combinations: rows.length,
                represented_rows: rows.reduce(function (sum, row) { return sum + row.count; }, 0),
                additional_values: "first_row_example_only"
            }};
        });
    }
    window.recommendationSheet = {readModelAdvice: readModelAdvice};
})();
