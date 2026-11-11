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
        var jobs = window.createOperationJobs(
            options.api,
            options.getConversationId
        );
        var formula = window.createWorkspaceFormula({
            getWorkspace: function () { return workspace; },
            getTarget: function () { return target; },
            getLastFormula: function () { return lastFormula; },
            refresh: refresh, newRequestId: options.api.newRequestId
        });
        var operations = window.createOperations({
            api: options.api,
            jobs: jobs,
            isBusy: options.isBusy,
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
        var similarity = window.createSimilarityController({
            api: options.api, isBusy: options.isBusy, setBusy: options.setBusy,
            status: ui.status, complete: options.complete,
            getInput: async function () {
                if (!workspace || !target) throw new Error(window.errorMessages.WORKSPACE_REQUIRED);
                await refresh();
                return {workspace: workspace, target: target};
            }
        });
        function referenceTarget() {
            if (!workspace) return null;
            return {workspace_id: workspace.workspace_id, worksheet_id: workspace.worksheet_id,
                table_id: String(workspace.table_id), sheet_name: workspace.sheet_name, task_type: workspace.task_type};
        }
        async function save() {
            if (!workspace) return;

            workspace.target = target;
            workspace.target_column_ids = operations.targets();
            workspace.last_result_column_ids = lastResults;
            workspace.finalized = finalized;

            await window.workspaceStore.save(workspace);
            if (options.onWorkspaceReady) await options.onWorkspaceReady(referenceTarget());
        }
        async function refresh() {
            if (!workspace) return false;
            var previous = JSON.stringify(workspace.columns), lostTarget = false;
            await Excel.run(async function (context) {
                var info = await window.workspaceTable.layout(context, workspace);
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
            similarity.reset();
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
                display(workspace.columns.filter(function (c) {
                    return c.role === defaultRole;
                }).map(function (c) {
                    return String(c.column_id);
                }), true);
                await save();

                ui.status(
                    "작업 시트를 만들었습니다. 원본은 유지됩니다. " +
                    "처리할 열과 기능을 선택하세요."
                );
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
                display(next.columns.map(function (c) { return String(c.column_id); }));
                await save(); ui.status("현재 작업 대상을 변경했습니다. 기존 결과와 직접 수정한 값은 유지됩니다.");
            } catch (error) { ui.status(error.message); }
            finally { options.setBusy(false); }
        }
        async function activate(saved) {
            if (!saved || !profiles[saved.task_type]) {
                throw new Error("저장된 작업 시트를 찾을 수 없습니다.");
            }

            var previous = {
                workspace: workspace,
                target: target,
                type: type,
                lastResults: lastResults,
                finalized: finalized,
                lastFormula: lastFormula,
                ids: operations.targets().slice()
            };

            try {
                workspace = JSON.parse(JSON.stringify(saved));
                target = null;
                type = saved.task_type;
                lastResults = (
                    saved.last_result_column_ids || []
                ).map(String);
                finalized = saved.finalized || null;
                lastFormula = null;

                await refresh();

                target = await window.workspaceSheet.readWorkspaceTarget(
                    workspace,
                    true
                );

                if (!target) {
                    throw new Error(
                        "저장된 작업 시트의 범위를 확인할 수 없습니다."
                    );
                }

                if (
                    saved.target &&
                    saved.target.row_start >= target.row_start &&
                    saved.target.row_count > 0 &&
                    saved.target.row_start + saved.target.row_count <=
                        target.row_start + target.row_count
                ) {
                    target.row_start = saved.target.row_start;
                    target.row_count = saved.target.row_count;
                }

                ui.open(type);
                display(saved.target_column_ids || lastResults, true);

                await save();

                source = null;
                ready = false;
                creationName = null;
            } catch (error) {
                workspace = previous.workspace;
                target = previous.target;
                type = previous.type;
                lastResults = previous.lastResults;
                finalized = previous.finalized;
                lastFormula = previous.lastFormula;

                if (workspace && target) {
                    ui.open(type);
                    display(previous.ids, true);
                } else {
                    operations.reset();
                    ui.open(type);
                    ui.setup();
                }

                throw error;
            }
        }

        async function restore() {
            if (options.isBusy()) return;
            options.setBusy(true);

            try {
                window.workspaceSheet.requireExcel("1.9");

                await activate(await window.workspaceStore.current());

                ui.status(
                    "저장된 작업 시트를 불러왔습니다. " +
                    "현재 값으로 이어서 작업합니다."
                );
            } catch (error) {
                ui.status(error.message);
            } finally {
                options.setBusy(false);
            }
        }
        function newSource() {
            similarity.reset();
            source = null; ready = false; creationName = null;
            workspace = target = null; lastResults = []; lastFormula = null; finalized = null;
            operations.reset(); ui.setup();
        }
        async function open(nextType) {
            var wasBusy = options.isBusy();
            options.enterConversation();
            options.setBusy(true);

            try {
                await save();

                type = nextType || type;
                ui.open(type);

                if (!workspace || workspace.task_type !== type) {
                    newSource();
                    ui.status(
                        "원본 범위를 가져오거나 저장된 작업 이어가기를 누르세요."
                    );
                } else {
                    await refresh();
                    display(operations.targets());
                }

            } catch (error) {
                ui.status(error.message);
            } finally {
                options.setBusy(wasBusy);
            }
        }
        ui.bind({
            select: select,
            start: start,
            restore: restore,

            target: function () {
                chooseTarget(false);
            },
            return: function () {
                chooseTarget(true);
            },

            new: async function () {
                if (options.isBusy()) return;
                options.setBusy(true);

                try {
                    await save();
                    newSource();


                    ui.status(
                        "새 원본을 선택하세요. 기존 작업 시트는 유지됩니다."
                    );
                } catch (error) {
                    ui.status(error.message);
                } finally {
                    options.setBusy(false);
                }
            },

            type: function (nextType) {
                if (!options.isBusy()) return open(nextType);
            }
        });
        return {
            open: open,
            dismiss: function () { operations.invalidate(); similarity.reset(); ui.hide(); },
            reset: function () { similarity.reset(); source = workspace = target = null; lastResults = []; lastFormula = null; ready = false; finalized = null; operations.reset(); ui.reset(); },
            setBusy: function (busy) { ui.busy(busy, ready); operations.busy(busy); similarity.busy(); },
            referenceTarget: referenceTarget,
            context: async function () {
                if (!workspace) return null;
                await refresh();
                var sampleRows = await operations.sampleRows();
                return {workspace_id: workspace.workspace_id,
                    task_type: workspace.task_type, worksheet_id: workspace.worksheet_id,
                    table_id: String(workspace.table_id), sheet_name: workspace.sheet_name, row_count: target.row_count,
                    columns: workspace.columns.map(function (c) { return {column_id: String(c.column_id), header: c.header,
                        role: c.role, description: c.description || ""}; }),
                    target_column_ids: operations.targets(), last_result_column_ids: lastResults,
                    sample_rows: sampleRows.map(function (row) { return {excel_row: row.excel_row,
                        values: row.values.map(function (v) { return v.slice(0, 1000); }),
                        truncated: row.values.some(function (v) { return v.length > 1000; })}; })};
            },
            readRecommendation: async function (columnIds, expected, progress, check) {
                if (check) check();
                if (!workspace || !expected) throw new Error(window.errorMessages.WORKSPACE_REQUIRED);
                await refresh();
                return window.readRecommendation(workspace, columnIds, expected, progress, check);
            },
            configureSimilarity: async function (settings) {
                if (!workspace) throw new Error(window.errorMessages.WORKSPACE_SETUP_REQUIRED);
                await refresh(); ui.open(workspace.task_type); display([settings.column_id]);
                similarity.show(workspace, target, settings);
                ui.status("검사 대상을 확인하고 실행하세요. 결과는 새 시트에 작성합니다.");
            },
            recommendExtraction: function () { return operations.recommendExtraction(); },
            configure: async function (operation) {
                if (!workspace) throw new Error(window.errorMessages.WORKSPACE_SETUP_REQUIRED);
                await refresh(); ui.open(workspace.task_type); display(operation.column_ids); operations.configure(operation);
                ui.status("요청한 설정을 채웠습니다. 대상·조건을 확인하고 ‘변경 내용 확인’을 누르세요.");
            },
            formulaTarget: formula.formulaTarget,
            validateFormulaSource: formula.validateFormulaSource,
            prepareFormulaOutput: formula.prepareFormulaOutput,
            formulaResultColumns: formula.formulaResultColumns,
            formulaResult: async function (result, selection, ids) {
                if (!selection.workspace_id) {
                    lastFormula = result.targets.length === 1 ? Object.assign({worksheet_id: selection.worksheet_id}, result.targets[0]) : null;
                    return;
                }
                if (!workspace || selection.workspace_id !== workspace.workspace_id) throw new Error("수식 결과의 작업 표가 바뀌었습니다.");
                operations.invalidate();
                lastFormula = null;
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
