"use strict";
(function () {
    window.readAgentData = async function (getInput, expected, spec, progress, check) {
        var sheet = window.operationsSheet;
        async function read() {
            check();
            var current = await getInput();
            var work = current.workspace, target = current.target;
            if (["workspace_id", "worksheet_id", "table_id", "task_type"].some(function (key) {
                return String(work[key]) !== String(expected[key]);
            }) || target.row_count !== expected.row_count || expected.row_start != null && target.row_start !== expected.row_start ||
                sheet.filterKey(work.row_filter) !== sheet.filterKey(expected.row_filter)) {
                throw new Error("작업표나 현재 범위가 바뀌었습니다. 최신 상태로 다시 요청하세요.");
            }
            return sheet.read(work, target, spec.column_ids, progress, check, null, null, null, spec.condition, true);
        }
        var snapshot = await read();
        async function verify() {
            var latest = await read();
            if (snapshot.stamp !== latest.stamp || JSON.stringify(snapshot.rows) !== JSON.stringify(latest.rows) ||
                JSON.stringify(snapshot.scope_rows) !== JSON.stringify(latest.scope_rows)) {
                throw new Error("읽은 뒤 입력값·행 순서·표 구성이 바뀌었습니다. 최신 값으로 다시 확인하세요.");
            }
            check();
        }
        await verify();
        return {rows: snapshot.rows.map(function (row) {
            return {identity: row.identity, excel_row: row.excel_row, values: row.values};
        }), verify: verify};
    };
})();
