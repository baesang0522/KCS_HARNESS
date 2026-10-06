"use strict";
(function () {
    var profiles = {
        model_normalization: {name: "모델규격 정제", prefix: "모델규격", roles: [
            {key: "declared_name", labels: ["신고품명"]}, {key: "trade_name", labels: ["거래품명"]},
            {key: "model_spec", labels: ["모델규격", "모델명"]}]},
        counterparty_cleanup: {name: "해외거래처부호 정제", prefix: "해외거래처", roles: [
            {key: "country_code", labels: ["국가코드", "국가부호"]},
            {key: "party_code", labels: ["해외거래처부호", "해외거래처코드"]},
            {key: "company_name", labels: ["해외거래처상호", "상호명", "상호", "해외거래처명"]}]}
    };
    window.workspaceProfiles = profiles;
    window.createWorkspaceController = function (options) {
        var ui = window.createWorkspaceUI(), type = "model_normalization";
        var source = null, workspace = null, target = null, creationName = null, ready = false;
        var lastResults = [], finalized = null, lastFormula = null;
        var operations = window.createOperations({api: options.api, isBusy: options.isBusy,
            setBusy: options.setBusy, status: ui.status, complete: options.complete, refresh: refresh,
            changed: function () { lastFormula = null; finalized = null; },
            result: async function (result) {
                workspace.columns = workspace.columns.concat(result.columns);
                lastResults = result.columns.map(function (c) { return String(c.column_id); });
                target = Object.assign({}, result, {worksheet_id: workspace.worksheet_id, sheet_name: workspace.sheet_name});
                finalized = null; lastFormula = null; display(lastResults, true);
                try { await save(); } catch (error) { throw new Error("결과 작성은 완료됐지만 작업 정보 저장에 실패했습니다. " + error.message); }
            },
            finalized: async function (ids, count) { finalized = {column_ids: ids, row_count: count, at: new Date().toISOString()}; await save(); }
        });
        async function save() {
            if (!workspace) return;
            await Excel.run(async function (context) {
                context.workbook.settings.add("kcs.workspace.current", Object.assign({}, workspace, {
                    target: target, last_result_column_ids: lastResults, finalized: finalized
                })); await context.sync();
            });
        }
        async function refresh() {
            if (!workspace) return false;
            var previous = JSON.stringify(workspace.columns), lostTarget = false;
            await Excel.run(async function (context) {
                var info = await window.operationsSheet.layout(context, workspace);
                workspace.sheet_name = info.sheet.name;
                workspace.row_count = info.body.rowCount;
                workspace.columns = info.columns.filter(function (c) { return c.column_id !== workspace.source_row_column_id; }).map(function (column) {
                    var known = workspace.columns.find(function (item) { return String(item.column_id) === String(column.column_id); });
                    return Object.assign({role: "reference", description: ""}, known || {}, column);
                });
                if (workspace.columns.length > 200) throw new Error("작업 표는 최대 200열입니다.");
                if (profiles[workspace.task_type].roles.some(function (role) {
                    return workspace.columns.filter(function (c) { return c.role === role.key; }).length !== 1;
                })) throw new Error("필수 열이 삭제되었거나 바뀌었습니다. 원본에서 새 작업을 시작하세요.");
                lastResults = lastResults.filter(function (id) { return workspace.columns.some(function (c) { return String(c.column_id) === id; }); });
            });
            if (previous !== JSON.stringify(workspace.columns) && target) {
                target.columns = (target.columns || []).flatMap(function (old) {
                    return workspace.columns.filter(function (column) { return String(column.column_id) === String(old.column_id); });
                });
                target.sheet_name = workspace.sheet_name;
                // 수식 대상은 위치 번호이므로 열 삽입·삭제 후 재선택한다.
                lastFormula = null; finalized = null;
                var role = workspace.task_type === "model_normalization" ? "model_spec" : "company_name";
                var fallback = lastResults.length ? lastResults.slice(0, 1) : workspace.columns.filter(function (c) { return c.role === role; }).map(function (c) { return String(c.column_id); });
                lostTarget = operations.reconcile(workspace, target, fallback);
                if (!target.columns.length) target.columns = workspace.columns.filter(function (c) { return fallback.includes(String(c.column_id)); });
                ui.current(workspace, target);
                if (lostTarget) ui.status("삭제된 열을 작업 대상에서 제외했습니다. 남아 있는 열로 이어서 작업할 수 있습니다.");
                await save();
            }
            return lostTarget;
        }
        function display(preferred, resetMode) {
            var ids = (preferred || lastResults).filter(function (id) { return workspace.columns.some(function (c) { return String(c.column_id) === String(id); }); });
            if (!ids.length) {
                var role = workspace.task_type === "model_normalization" ? "model_spec" : "company_name";
                ids = workspace.columns.filter(function (c) { return c.role === role; }).map(function (c) { return String(c.column_id); });
            }
            ui.current(workspace, target); operations.show(workspace, target, ids, resetMode);
        }
        function change() {
            if (!source) return;
            creationName = null;
            var indexes = ui.mapping();
            var count = new Set(indexes.filter(function (index) { return index >= 0; })).size;
            ready = indexes.length === 3 && count === 3;
            source.mapping = {};
            profiles[type].roles.forEach(function (role, i) { source.mapping[role.key] = indexes[i]; });
            source.reference_columns = ui.extras(); source.task_type = type; source.roles = profiles[type].roles.map(function (r) { return r.key; });
            ui.valid(ready, count, source.reference_columns.length, source.data_row_count);
            ui.status(ready ? "열 구성을 확인한 뒤 작업을 시작하세요. 필터로 숨겨진 행도 복사합니다." : "필수 세 역할에 서로 다른 열을 지정하세요.");
        }
        async function select() {
            if (options.isBusy()) return;
            options.setBusy(true);
            try {
                source = await window.workspaceSheet.readSource();
                ui.source(source, profiles[type], change);
            } catch (error) { ui.status(error.message); }
            finally { options.setBusy(false); }
        }
        async function start() {
            if (options.isBusy() || !source || !ready) return;
            options.setBusy(true);
            try {
                if (!creationName) creationName = profiles[type].prefix + "_" + options.api.newRequestId().replace(/-/g, "").slice(0, 16);
                var next = await window.workspaceCopy.create(source, creationName, function (done, total) { ui.status("작업 시트 복사 · " + done + "/" + total + "행"); });
                workspace = next; target = next.target; lastResults = []; finalized = null; lastFormula = null;
                var defaultRole = type === "model_normalization" ? "model_spec" : "company_name";
                display(workspace.columns.filter(function (c) { return c.role === defaultRole; }).map(function (c) { return String(c.column_id); }), true);
                ui.status("작업 시트를 만들었습니다. 원본은 유지됩니다. 처리할 열과 기능을 선택하세요.");
            } catch (error) { ui.status(error.message); }
            finally { options.setBusy(false); }
        }
        async function chooseTarget(activate) {
            if (options.isBusy() || !workspace) return;
            options.setBusy(true);
            try {
                await refresh();
                var next = await window.workspaceSheet.readWorkspaceTarget(workspace, activate);
                if (!next) throw new Error("현재 작업 시트의 열을 선택하세요. 다른 원본은 새 작업으로 시작할 수 있습니다.");
                target = next; lastFormula = null;
                display(next.columns.map(function (c) { return String(c.column_id); }).slice(0, 1));
                await save(); ui.status("현재 작업 대상을 변경했습니다. 기존 결과와 직접 수정한 값은 유지됩니다.");
            } catch (error) { ui.status(error.message); }
            finally { options.setBusy(false); }
        }
        async function restore() {
            if (options.isBusy()) return;
            options.setBusy(true);
            try {
                window.workspaceSheet.requireExcel("1.9");
                var saved = await Excel.run(async function (context) {
                    var setting = context.workbook.settings.getItemOrNullObject("kcs.workspace.current");
                    setting.load("value"); await context.sync(); return setting.isNullObject ? null : setting.value;
                });
                if (!saved || !profiles[saved.task_type]) throw new Error("이 통합문서에 저장된 작업이 없습니다.");
                workspace = saved; target = null; type = saved.task_type; finalized = saved.finalized || null;
                lastResults = (saved.last_result_column_ids || []).map(String);
                await refresh();
                target = await window.workspaceSheet.readWorkspaceTarget(workspace, true);
                if (saved.target && saved.target.row_start >= target.row_start && saved.target.row_count > 0 &&
                    saved.target.row_start + saved.target.row_count <= target.row_start + target.row_count) {
                    target.row_start = saved.target.row_start; target.row_count = saved.target.row_count;
                }
                ui.open(type); display(lastResults, true); ui.status("저장된 작업 시트를 불러왔습니다. 현재 값으로 이어서 작업합니다.");
            } catch (error) { workspace = target = null; operations.reset(); ui.setup(); ui.status(error.message); }
            finally { options.setBusy(false); }
        }
        function newSource() {
            source = null; ready = false; creationName = null;
            workspace = target = null; lastResults = []; lastFormula = null; finalized = null;
            operations.reset(); ui.setup();
        }
        async function open(nextType) {
            type = nextType || type; options.enterConversation(); ui.open(type);
            if (!workspace || workspace.task_type !== type) { newSource(); ui.status("머리글을 포함한 원본 범위를 선택하고 가져오세요."); return; }
            var wasBusy = options.isBusy(); options.setBusy(true);
            try { await refresh(); display(operations.targets()); }
            catch (error) { ui.status(error.message); }
            finally { options.setBusy(wasBusy); }
        }
        ui.bind({select: select, start: start, restore: restore,
            target: function () { chooseTarget(false); }, return: function () { chooseTarget(true); },
            new: function () { if (options.isBusy()) return; newSource(); ui.status("새 원본을 선택하세요. 기존 작업 시트는 유지됩니다."); },
            type: function (nextType) { type = nextType; newSource(); ui.status("선택한 업무의 필수 열을 지정하세요."); }
        });
        return {
            open: open,
            dismiss: function () { operations.invalidate(); ui.hide(); },
            reset: function () { source = workspace = target = null; lastResults = []; lastFormula = null; ready = false; finalized = null; operations.reset(); ui.reset(); },
            setBusy: function (busy) { ui.busy(busy, ready); operations.busy(busy); },
            context: async function () {
                if (!workspace) return null;
                await refresh();
                var sampleRows = await operations.sampleRows();
                return {task_type: workspace.task_type, worksheet_id: workspace.worksheet_id,
                    table_id: String(workspace.table_id), sheet_name: workspace.sheet_name, row_count: target.row_count,
                    columns: workspace.columns.map(function (c) { return {column_id: String(c.column_id), header: c.header,
                        role: c.role, description: c.description || ""}; }),
                    target_column_ids: operations.targets(), last_result_column_ids: lastResults,
                    sample_rows: sampleRows.map(function (row) { return {excel_row: row.excel_row,
                        values: row.values.map(function (v) { return v.slice(0, 1000); }),
                        truncated: row.values.some(function (v) { return v.length > 1000; })}; })};
            },
            configure: async function (operation) {
                if (!workspace) throw new Error("먼저 필수 세 열을 지정해 작업을 시작하세요.");
                await refresh(); ui.open(workspace.task_type); display(operation.column_ids); operations.configure(operation);
                ui.status("요청한 설정을 채웠습니다. 대상·조건을 확인하고 ‘변경 내용 확인’을 누르세요.");
            },
            formulaTarget: async function () {
                if (!workspace) return lastFormula;
                await refresh();
                var ids = lastFormula && lastResults.length ? lastResults : operations.targets();
                var columns = workspace.columns.filter(function (c) { return ids.indexOf(String(c.column_id)) >= 0; }).sort(function (a, b) { return a.column_index - b.column_index; });
                if (!columns.length || columns.some(function (c, i) { return c.column_index !== columns[0].column_index + i; })) {
                    throw new Error("수식에 사용할 연속된 열을 작업 시트에서 선택해 주세요.");
                }
                return {worksheet_id: workspace.worksheet_id, row_start: target.row_start, row_count: target.row_count,
                    column_start: columns[0].column_index, column_count: columns.length};
            },
            prepareFormulaOutput: async function (preview, selection) {
                if (!workspace || workspace.worksheet_id !== selection.worksheet_id) return;
                await Excel.run(async function (context) {
                    var info = await window.operationsSheet.layout(context, workspace);
                    var ranges = preview.plan.actions.map(function (action) {
                        var range = info.sheet.getRange(action.target_range);
                        range.load("rowIndex,rowCount,columnIndex,columnCount"); return range;
                    });
                    await context.sync();
                    var end = Math.max.apply(null, ranges.map(function (r) { return r.columnIndex + r.columnCount; }));
                    var oldEnd = info.body.columnIndex + info.body.columnCount;
                    if (ranges.some(function (r) { return r.rowIndex < info.body.rowIndex ||
                        r.rowIndex + r.rowCount > info.body.rowIndex + info.body.rowCount ||
                        r.columnIndex < info.body.columnIndex + 1; })) throw new Error("수식 결과는 현재 작업 표의 데이터 행에 작성하세요.");
                    if (end - info.body.columnIndex > 201) throw new Error("작업 표는 최대 200개 데이터 열입니다.");
                    if (end <= oldEnd) return;
                    var extension = info.sheet.getRangeByIndexes(info.body.rowIndex - 1, oldEnd, info.body.rowCount + 1, end - oldEnd);
                    var occupied = extension.getUsedRangeOrNullObject(); occupied.load("address"); await context.sync();
                    if (!occupied.isNullObject) throw new Error("수식 결과까지의 공간에 기존 데이터가 있습니다. 작업 표의 빈 열을 선택하세요.");
                    for (var columnIndex = oldEnd; columnIndex < end; columnIndex++) {
                        var actionIndex = ranges.findIndex(function (r) { return r.columnIndex === columnIndex; });
                        var label = actionIndex >= 0 ? preview.plan.actions[actionIndex].output_label : "추가 열";
                        info.table.columns.add(null, null, label + " " + options.api.newRequestId().slice(0, 6));
                    }
                    await context.sync();
                });
            },
            formulaResult: async function (result, selection) {
                lastFormula = result.targets.length === 1 ? Object.assign({worksheet_id: selection.worksheet_id}, result.targets[0]) : null;
                if (!workspace || selection.worksheet_id !== workspace.worksheet_id) return;
                operations.invalidate();
                await refresh();
                var ids = result.targets.flatMap(function (range) { return workspace.columns.filter(function (c) {
                    return c.column_index >= range.column_start && c.column_index < range.column_start + range.column_count;
                }).map(function (c) { return String(c.column_id); }); });
                workspace.columns.forEach(function (c) {
                    if (ids.indexOf(String(c.column_id)) >= 0 && c.role === "reference") {
                        c.role = "result"; c.description = "승인한 수식 결과";
                    }
                });
                lastResults = ids; finalized = null;
                if (ids.length) {
                    target = Object.assign({}, target, {row_start: result.targets[0].row_start, row_count: result.targets[0].row_count}); display(ids, true);
                }
                await save();
            }
        };
    };
})();
