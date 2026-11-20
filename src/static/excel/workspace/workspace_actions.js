"use strict";
(function () {
    // 작업표 상태를 보관하지 않는다. 저장·복원은 workspace 컨트롤러가 맡는다.
    async function prepareScope(workspace, target, request, check) {
        var sheet = window.operationsSheet;
        if (!["replace", "include", "exclude", "clear"].includes(request.mode)) throw new Error("지원하지 않는 범위 변경입니다.");
        var filter = request.condition;
        if (request.mode !== "clear") {
            if (!filter || !workspace.columns.some(function (c) { return String(c.column_id) === filter.column_id; })) throw new Error("조건 열을 다시 선택하세요.");
            if (!["equals", "not_equals", "contains", "blank", "not_blank"].includes(filter.operator)) throw new Error("조건을 다시 선택하세요.");
            if (typeof filter.value !== "string" || filter.value.length > 32767) throw new Error("비교할 값을 확인하세요.");
            if (!["blank", "not_blank"].includes(filter.operator) && !filter.value.trim()) throw new Error("비교할 값을 입력하세요. 빈 셀은 ‘빈칸’ 조건을 선택하세요.");
        } else if (filter) throw new Error("전체 행으로 돌아갈 때는 조건을 지정하지 마세요.");
        var previous = workspace.row_filter || null;
        var next = request.mode === "clear" ? null : filter, nextTarget = target;
        if (["include", "exclude"].includes(request.mode)) {
            var current = await sheet.read(workspace, target, [], function () {}, check, null, null, null, null, true);
            next = previous && previous.steps && !current.range_ids ? JSON.parse(JSON.stringify(previous)) : {base: previous, steps: [], base_ids: current.range_ids};
            // 정렬 후에도 기존 선택 행을 유지하고, 추가 조건은 전체 작업표에서 찾는다.
            next.steps.push({mode: request.mode, condition: filter});
        }
        if (["include", "exclude", "clear"].includes(request.mode)) {
            var whole = await Excel.run(async function (context) {
                var info = await window.workspaceTable.layout(context, workspace);
                return {row_start: info.body.rowIndex, row_count: info.body.rowCount};
            });
            nextTarget = Object.assign({}, target, whole);
        }
        var selected = await sheet.read(Object.assign({}, workspace, {row_filter: next}), nextTarget, [], function () {}, check, null, null, null, null, true);
        return {filter: next, target: nextTarget, row_count: selected.rows.length};
    }

    function assignRole(workspace, role, profiles) {
        var column = workspace.columns.find(function (c) { return String(c.column_id) === role.column_id; });
        if (!column) throw new Error("역할을 지정할 열이 없습니다.");
        if (workspace.task_type !== "investigation" && column.role !== role.role &&
            profiles[workspace.task_type].roles.some(function (r) { return r.key === column.role; })) {
            throw new Error("이전 작업표의 필수 역할은 유지해야 합니다. 자유롭게 구성하려면 새 통합 조사를 시작하세요.");
        }
        var previousRoles = new Map(workspace.columns.map(function (c) { return [String(c.column_id), c.role]; }));
        if (role.role !== "reference") workspace.columns.forEach(function (c) { if (c.role === role.role) c.role = "reference"; });
        column.role = role.role;
        return {column: column, previousRoles: previousRoles};
    }

    async function importColumns(workspace, sourceColumns, importPolicy, ui, onImported) {
        var imported = 0;
        if (!sourceColumns.length) throw new Error("추가할 원본 열을 선택하세요.");
        if (workspace.columns.length + sourceColumns.length > 200) throw new Error("작업 표는 최대 200열입니다. 선택한 열 수를 줄이세요.");
        for (var sourceColumn of sourceColumns) {
            var result = await window.sourceColumns.append(workspace, sourceColumn.column_id, function (label, done, total) {
                ui.status("열 가져오기 " + (imported + 1) + "/" + sourceColumns.length + " · " + label + " · " + done + "/" + total);
            }, Object.assign({}, importPolicy, {header: sourceColumn.header}));
            workspace.columns = workspace.columns.concat(result.columns);
            imported++;
            await onImported(imported);
        }
    }

    window.workspaceActions = {prepareScope: prepareScope, assignRole: assignRole, importColumns: importColumns};
})();
