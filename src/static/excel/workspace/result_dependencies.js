"use strict";
(function () {
    var table = window.workspaceTable, sheet = window.operationsSheet;
    async function digest(rows) {
        if (!window.crypto || !window.crypto.subtle) throw new Error("결과 변경 확인 기능을 사용할 수 없습니다. 추가 기능의 연결 환경을 확인하세요.");
        rows.sort(function (a, b) { return a[0] - b[0]; });
        var bytes = new TextEncoder().encode(JSON.stringify(rows));
        var hash = await window.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash), function (value) { return value.toString(16).padStart(2, "0"); }).join("");
    }
    function referenced(record) {
        return Array.from(new Set(record.input_ids.concat((record.links || []).map(function (link) { return link.input_id; }), sheet.filterColumns(record.filter), sheet.filterColumns(record.condition))));
    }
    async function read(workspace, record) {
        return Excel.run(async function (context) {
            var info = await table.layout(context, workspace), ids = referenced(record);
            var columns = table.selectedColumns(info, ids), rows = [], seen = new Set();
            var range = record.range_ids == null ? null : new Set(record.range_ids);
            var fixed = record.fixed_ids == null ? null : new Set(record.fixed_ids);
            var accepts = sheet.compileFilter(record.filter), condition = sheet.compileFilter(record.condition);
            for (var offset = 0; offset < info.body.rowCount; offset += table.batchSize) {
                var part = await table.chunk(context, info, info.body.rowIndex + offset,
                    Math.min(table.batchSize, info.body.rowCount - offset), columns, record.raw);
                part.forEach(function (row) {
                    if (!Number.isSafeInteger(row.identity) || row.identity < 1 || seen.has(row.identity)) throw new Error("원본 행 식별값이 없거나 중복되었습니다.");
                    seen.add(row.identity);
                    function value(id) { return row.values[ids.indexOf(id)]; }
                    if (range && !range.has(row.identity)) return;
                    if (fixed ? !fixed.has(row.identity) : !accepts(value, row.identity) || !condition(value, row.identity)) return;
                    rows.push([row.identity].concat(record.input_ids.map(value)));
                });
            }
            if ((await table.layout(context, workspace)).stamp !== info.stamp) throw new Error("재검토 확인 중 표 구성이 바뀌었습니다. 다시 요청하세요.");
            return {digest: await digest(rows), coverage: await digest(rows.map(function (row) { return [row[0]]; })),
                count: rows.length, full: rows.length === info.body.rowCount};
        });
    }
    async function fromSnapshot(snapshot, outputIds) {
        var inputs = snapshot.columns.map(function (c) { return String(c.column_id); }).filter(function (id) { return !outputIds.includes(id); });
        var selectors = sheet.filterColumns(snapshot.row_filter).concat(sheet.filterColumns(snapshot.condition));
        var selfSelected = selectors.some(function (id) { return outputIds.includes(id); });
        var record = {output_ids: outputIds, input_ids: inputs, filter: snapshot.row_filter, condition: snapshot.condition || null,
            range_ids: snapshot.range_ids || null,
            fixed_ids: selfSelected ? snapshot.rows.map(function (row) { return row.identity; }) : null,
            scope_key: snapshot.row_filter ? sheet.filterKey(snapshot.row_filter) : null,
            needs_review: false};
        var indexes = inputs.map(function (id) { return snapshot.columns.findIndex(function (c) { return String(c.column_id) === id; }); });
        var rows = snapshot.rows.map(function (row) { return [row.identity].concat(indexes.map(function (i) { return row.values[i]; })); });
        record.digest = await digest(rows);
        record.coverage = await digest(rows.map(function (row) { return [row[0]]; }));
        record.full = rows.length === snapshot.workspace.row_count;
        return record;
    }
    function register(workspace, record) {
        var records = workspace.result_dependencies || [];
        // shortcut: 부분 재실행은 덮지 않은 결과의 재검토 상태를 유지한다. 행별 검토 해제가 필요하면 기록을 분할한다.
        records.forEach(function (old) {
            if (record.full || (record.coverage && old.coverage === record.coverage)) old.output_ids = old.output_ids.filter(function (id) { return !record.output_ids.includes(id); });
        });
        workspace.result_dependencies = records.filter(function (old) { return old.output_ids.length; }).concat(record);
    }
    async function reconcile(workspace) {
        var records = workspace.result_dependencies || [], known = new Set(workspace.columns.map(function (c) { return String(c.column_id); }));
        var before = JSON.stringify(records);
        for (var record of records) {
            record.output_ids = record.output_ids.filter(function (id) { return known.has(id); });
            if (!record.output_ids.length || record.needs_review) continue;
            if (referenced(record).some(function (id) { return !known.has(id); }) ||
                (record.scope_key !== null && record.scope_key !== sheet.filterKey(workspace.row_filter))) {
                record.needs_review = true;
            } else if ((await read(workspace, record)).digest !== record.digest) record.needs_review = true;
            for (var link of record.links || []) {
                if (record.needs_review) break;
                var linked = Object.assign({}, record, {input_ids: [link.input_id], links: [], range_ids: link.range_ids === undefined ? record.range_ids : link.range_ids});
                if ((await read(workspace, linked)).digest !== link.digest) record.needs_review = true;
            }
        }
        var stale = new Set(records.filter(function (record) { return record.needs_review; }).flatMap(function (record) { return record.output_ids; }));
        var changed;
        do {
            changed = false;
            records.forEach(function (record) {
                if (!record.needs_review && referenced(record).some(function (id) { return !record.output_ids.includes(id) && stale.has(id); })) {
                    record.needs_review = true; record.output_ids.forEach(function (id) { stale.add(id); }); changed = true;
                }
            });
        } while (changed);
        if (workspace.result_dependencies) workspace.result_dependencies = records.filter(function (record) { return record.output_ids.length; });
        return before !== JSON.stringify(workspace.result_dependencies || []);
    }
    async function reconcileStages(workspace, versions) {
        var changed = false, stale = new Set();
        var known = new Set(workspace.columns.map(function (column) { return String(column.column_id); }));
        for (var stage of workspace.selection_stages || []) {
            var reason = stage.review_reason;
            if (stage.status !== 'needs_review') {
                if (stage.parent_id && stale.has(stage.parent_id)) reason = '이전 선별 단계가 바뀌었습니다.';
                else if (versions !== null && (stage.request.condition_ids || []).some(function (id) {
                    return !stage.request.condition_versions || versions[id] !== stage.request.condition_versions[id];
                })) reason = 'PDF 조건이 수정되거나 삭제되었습니다.';
                else if (referenced(stage.evidence).some(function (id) { return !known.has(id); })) reason = '조건 열이 삭제되었습니다.';
                else if ((await read(workspace, stage.evidence)).digest !== stage.evidence.digest) reason = '선별 입력값이나 후보 행이 바뀌었습니다.';
                if (reason) { stage.status = 'needs_review'; stage.review_reason = reason; changed = true; }
            }
            if (stage.status === 'needs_review') stale.add(stage.stage_id);
        }
        return changed;
    }
    function required(workspace) {
        return Array.from(new Set((workspace.result_dependencies || []).filter(function (record) { return record.needs_review; }).flatMap(function (record) { return record.output_ids; })));
    }
    async function formula(workspace, selection) {
        var record = {output_ids: [], input_ids: selection.input_columns.map(function (c) { return c.column_id; }),
            filter: null, condition: null, range_ids: null, fixed_ids: null, scope_key: null, raw: true, needs_review: false};
        await Excel.run(async function (context) {
            var info = await table.layout(context, workspace);
            if (selection.row_start !== info.body.rowIndex || selection.row_count !== info.body.rowCount) {
                record.range_ids = [];
                for (var offset = 0; offset < selection.row_count; offset += table.batchSize) {
                    var part = await table.chunk(context, info, selection.row_start + offset,
                        Math.min(table.batchSize, selection.row_count - offset), []);
                    record.range_ids.push.apply(record.range_ids, part.map(function (row) { return row.identity; }));
                }
            }
        });
        return Object.assign(record, await read(workspace, record));
    }
    function referencesOutput(formula, columnIndex, sheetName) {
        var source = (formula || "").replace(/"(?:[^"]|"")*"/g, '""');
        // Computed addresses cannot be resolved statically; retain all earlier outputs for these formulas.
        if (/\b(?:INDIRECT|OFFSET)\s*\(/i.test(source)) return true;
        var reference = /(?<![\w.])(?:(?:'((?:[^']|'')+)'|([\w가-힣]+))!)?\$?([A-Z]{1,3})(?:\$?([1-9]\d*))?(?:\s*:\s*\$?([A-Z]{1,3})(?:\$?[1-9]\d*)?)?(?![\w(])/gi;
        function column(text) { return Array.from(text.toUpperCase()).reduce(function (n, c) { return n * 26 + c.charCodeAt(0) - 64; }, 0) - 1; }
        for (var match of source.matchAll(reference)) {
            var name = match[1] ? match[1].replace(/''/g, "'") : match[2];
            if (name && name.toLowerCase() !== (sheetName || "").toLowerCase()) continue;
            if (!match[4] && !match[5]) continue;
            var first = column(match[3]), last = match[5] ? column(match[5]) : first;
            if (columnIndex >= Math.min(first, last) && columnIndex <= Math.max(first, last)) return true;
        }
        return false;
    }
    async function formulaResults(workspace, baseline, plan, result, selection, ids) {
        var records = [];
        for (var index = 0; index < ids.length; index++) {
            var record = Object.assign({}, baseline, {output_ids: [ids[index]], links: [], coverage: null,
                full: baseline.full && result.targets[index].row_start === selection.row_start && result.targets[index].row_count === selection.row_count});
            for (var previous = 0; previous < index; previous++) {
                if (!referencesOutput(plan.actions[index].formula, result.targets[previous].column_start, selection.sheet_name)) continue;
                var input = await formula(workspace, Object.assign({}, selection, result.targets[previous], {input_columns: [{column_id: ids[previous]}]}));
                record.links.push({input_id: ids[previous], digest: input.digest, range_ids: input.range_ids});
            }
            records.push(record);
        }
        return records;
    }
    window.resultDependencies = {reconcileStages: reconcileStages,fromSnapshot: fromSnapshot, formulaResults: formulaResults, referencesOutput: referencesOutput, read: read, register: register, reconcile: reconcile, required: required, formula: formula};
})();
