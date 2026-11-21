"use strict";
(function () {
    // 작업표 상태를 보관하지 않는다. 저장·복원은 workspace 컨트롤러가 맡는다.
    async function prepareScope(workspace, target, request, check) {
        var sheet = window.operationsSheet, dependencies = window.resultDependencies;
        if (!["replace", "include", "exclude", "intersect", "clear", "revisit"].includes(request.mode)) throw new Error("지원하지 않는 범위 변경입니다.");
        var filter = request.condition, ids = [], previous = workspace.row_filter || null;
        if (!["clear", "revisit"].includes(request.mode)) {
            if (!filter || (!filter.column_id && !filter.conditions)) throw new Error("조건 열을 다시 선택하세요.");
            ids = sheet.filterColumns(filter);
            if (ids.some(function (id) { return !workspace.columns.some(function (c) { return String(c.column_id) === id; }); })) throw new Error("조건 열을 다시 선택하세요.");
        } else if (filter) throw new Error("범위 복귀에는 새 조건을 지정하지 마세요.");
        var next = request.mode === "clear" ? null : filter, nextTarget = target;
        if (request.mode !== "replace") {
            var whole = await Excel.run(async function (context) {
                var info = await window.workspaceTable.layout(context, workspace);
                return {row_start: info.body.rowIndex, row_count: info.body.rowCount};
            });
            nextTarget = Object.assign({}, target, whole);
        }
        var before = await sheet.read(workspace, ["clear", "revisit"].includes(request.mode) ? nextTarget : target, ids, function () {}, check, null, null, null, null, true);
        if (["include", "exclude", "intersect"].includes(request.mode)) {
            next = request.mode === "intersect" ? {base: previous, steps: [], base_ids: before.rows.map(function (row) { return row.identity; })} :
                previous && previous.steps && !before.range_ids ? JSON.parse(JSON.stringify(previous)) : {base: previous, steps: [], base_ids: before.range_ids};
            next.steps.push({mode: request.mode, condition: filter});
        }

        if (request.mode === "revisit") {
            var source = (workspace.selection_stages || []).find(function (stage) { return stage.stage_id === request.stage_id; });
            if (!source || !["pending", "input"].includes(request.revisit)) throw new Error("재검토할 선별 단계를 확인하세요.");
            next = {row_ids: (request.revisit === "pending" ? source.pending_ids : source.input_ids).slice()};
        }
        var input = before;
        if (["replace", "include", "clear", "revisit"].includes(request.mode)) {
            input = await sheet.read(Object.assign({}, workspace, {row_filter: request.mode === "revisit" ? next : null}), nextTarget, ids, function () {}, check, null, null, null, null, true);
            if (request.mode === "revisit" && input.rows.length !== next.row_ids.length) throw new Error("기록된 후보 행이 삭제되었습니다. 현재 원본 범위를 다시 확인하세요.");
        }
        var selected = await sheet.read(Object.assign({}, workspace, {row_filter: next}), nextTarget, [], function () {}, check, null, null, null, null, true);
        var selectedIds = new Set(selected.rows.map(function (row) { return row.identity; })), pending = [], excluded = [];
        input.rows.forEach(function (row) {
            if (selectedIds.has(row.identity)) return;
            var result = filter ? sheet.evaluatePredicate(filter, function (id) { return row.values[ids.indexOf(id)]; }) : false;
            (result === null ? pending : excluded).push(row.identity);
        });
        var evidence = await dependencies.fromSnapshot(input, []);
        if ((await dependencies.read(workspace, evidence)).digest !== evidence.digest) throw new Error("선별 중 입력값이나 후보가 바뀌었습니다. 다시 요청하세요.");
        return {filter: next, target: nextTarget, row_count: selected.rows.length, before_count: before.rows.length,
            stage: {request: JSON.parse(JSON.stringify(request)), status: "applied", review_reason: "", at: new Date().toISOString(),
                input_ids: input.rows.map(function (row) { return row.identity; }), selected_ids: Array.from(selectedIds),
                excluded_ids: excluded, pending_ids: pending, evidence: evidence}};
    }

    function stageSummaries(workspace) {
        return (workspace.selection_stages || []).map(function (stage) {
            return {stage_id: stage.stage_id, parent_id: stage.parent_id, origin_request_id: stage.origin_request_id,
                request: stage.request, status: stage.status, review_reason: stage.review_reason, at: stage.at,
                input_count: stage.input_ids.length, selected_count: stage.selected_ids.length,
                excluded_count: stage.excluded_ids.length, pending_count: stage.pending_ids.length};
        });
    }

    function validateBinding(request, versions) {
        var ids = request.condition_ids || [], expected = request.condition_versions || {};
        if (ids.some(function (id) { return !versions || !expected[id] || versions[id] !== expected[id]; })) {
            throw new Error("PDF 조건이 바뀌었거나 확인되지 않았습니다. 최신 조건으로 다시 요청하세요.");
        }
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

    window.workspaceActions = {prepareScope: prepareScope, stageSummaries: stageSummaries, validateBinding: validateBinding, assignRole: assignRole, importColumns: importColumns};
})();
