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
    profiles.investigation = {name: "통합 조사", prefix: "조사", roles: profiles.counterparty_cleanup.roles.concat(profiles.model_normalization.roles)};
    window.workspaceProfiles = profiles;
    window.createWorkspaceController = function (options) {
        var ui = window.createWorkspaceUI(options.messages), type = "investigation";
        var source = null, workspace = null, target = null, creationName = null, ready = false;
        var lastResults = [], finalized = null, lastFormula = null, groupReview = null;
        var dependencies = window.resultDependencies;
        var jobs = window.createOperationJobs(
            options.api,
            options.getConversationId,
            options.onJobCreated
        );
        var formula = window.createWorkspaceFormula({
            getWorkspace: function () { return workspace; },
            getLastFormula: function () { return lastFormula; },
            refresh: refresh, newRequestId: options.api.newRequestId,
            captureDependencies: function (selection) { return dependencies.formula(workspace, selection); },
            captureResults: function (baseline, plan, result, selection, ids) { return dependencies.formulaResults(workspace, baseline, plan, result, selection, ids); }
        });
        var operations = window.createOperations({
            api: options.api, recovery: options.recovery, messages: options.messages,
            jobs: jobs, beforeApply: options.beforeApply,
            isBusy: options.isBusy,
            setBusy: options.setBusy, status: ui.status, complete: options.complete, refresh: refresh,
            changed: function () { lastFormula = null; },
            prepareResult: function (snapshot, output) { return dependencies.fromSnapshot(snapshot, output.mode === "existing" ? [output.column_id].concat(output.score_column_id ? [output.score_column_id] : []) : []); },
            result: async function (result, job, snapshot, record) {
                workspace.columns = workspace.columns.filter(function (c) { return !result.columns.some(function (r) { return String(r.column_id) === String(c.column_id); }); }).concat(result.columns);
                lastResults = result.columns.map(function (c) { return String(c.column_id); });
                var keptRange = job && job.source.operation.condition ? {row_start: target.row_start, row_count: target.row_count} : {};
                target = Object.assign({}, result, {worksheet_id: workspace.worksheet_id, sheet_name: workspace.sheet_name, row_count: result.range_row_count || result.row_count}, keptRange);
                if (record) {
                    record.output_ids = lastResults;
                    dependencies.register(workspace, record);
                    await dependencies.reconcile(workspace);
                }
                finalized = null; lastFormula = null; display(lastResults, true);
                try { await save(); } catch (error) { throw new Error("결과 작성은 완료됐지만 작업 정보 저장에 실패했습니다. " + error.message); }
            },
            reviewed: async function (snapshot, columnId) {
                dependencies.register(workspace, await dependencies.fromSnapshot(snapshot, [columnId]));
                await dependencies.reconcile(workspace); ui.review(workspace); await save();
            },
            finalized: async function (ids, count, snapshot) {
                await refresh();
                if (dependencies.required(workspace).some(function (id) { return ids.includes(id); })) throw new Error("입력이나 범위가 바뀐 결과입니다. 재처리한 뒤 다시 확정하세요.");
                var record = await dependencies.fromSnapshot(snapshot, []);
                finalized = {column_ids: ids, row_count: count, at: new Date().toISOString(), evidence: record}; await save();
                showFinal();
            }
        });
        var similarity = window.createSimilarityController({
            api: options.api, messages: options.messages, isBusy: options.isBusy, setBusy: options.setBusy,
            status: ui.status, complete: options.complete,
            getInput: async function () {
                if (!workspace || !target) throw new Error(window.errorMessages.WORKSPACE_REQUIRED);
                await refresh();
                return {workspace: workspace, target: target};
            }
        });
        // 묶음 검토 보류(2026-11-18): 재사용 여부 검토 후 불필요하면 삭제. 기존 저장 정보는 보존.
        // async function openGroups(columnId, request) {
        //     try {
        //         if (!workspace) throw new Error("먼저 작업표를 만들거나 저장된 작업을 이어가세요.");
        //         if (options.showWorkspace) options.showWorkspace();
        //         if (!groupReview) groupReview = window.createGroupReview({
        //             api: options.api, messages: options.messages, isBusy: options.isBusy, setBusy: options.setBusy,
        //             getInput: async function () {
        //                 await refresh();
        //                 var whole = await Excel.run(async function (context) {
        //                     var info = await window.workspaceTable.layout(context, workspace);
        //                     return {row_start: info.body.rowIndex, row_count: info.body.rowCount};
        //                 });
        //                 return {workspace: workspace, target: whole};
        //             },
        //             saveReview: async function (review) {
        //                 var old = workspace.group_reviews || [];
        //                 workspace.group_reviews = old.filter(function (r) { return r.id !== review.id; }).concat(review);
        //                 try { await save(); } catch (error) { workspace.group_reviews = old; throw error; }
        //             },
        //             register: async function (result) {
        //                 workspace.columns = workspace.columns.filter(function (c) { return !result.columns.some(function (r) { return String(r.column_id) === String(c.column_id); }); }).concat(result.columns);
        //                 operations.invalidate(); lastFormula = finalized = null;
        //                 try { await refresh(); await save(); }
        //                 catch (error) { throw new Error("셀 반영은 끝났지만 작업 정보 저장에 실패했습니다. 자동 재실행하지 말고 결과 열을 확인하세요. " + error.message); }
        //             },
        //             setFilter: async function (filter) {
        //                 await refresh();
        //                 if (!workspace.columns.some(function (c) { return String(c.column_id) === filter.column_id; })) throw new Error("표시한 열이 삭제되었습니다.");
        //                 workspace.row_filter = filter; operations.invalidate(); lastFormula = finalized = null; await save();
        //             }
        //         });
        //         await groupReview.open(columnId, request);
        //     } catch (error) { document.getElementById("notice").textContent = error.message; }
        // }
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
                if (workspace.task_type !== "investigation" && profiles[workspace.task_type].roles.some(function (role) {
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
                lastFormula = null;
                var role = workspace.task_type === "model_normalization" ? "model_spec" : "company_name";
                var fallback = lastResults.length ? lastResults.slice(0, 1) : workspace.columns.filter(function (c) { return c.role === role; }).map(function (c) { return String(c.column_id); });
                lostTarget = operations.reconcile(workspace, target, fallback);
                if (!target.columns.length) target.columns = workspace.columns.filter(function (c) { return fallback.includes(String(c.column_id)); });
                ui.current(workspace, target);
                if (lostTarget) ui.status("삭제된 열을 작업 대상에서 제외했습니다. 남아 있는 열로 이어서 작업할 수 있습니다.");
                await save();
            }
            if (await dependencies.reconcile(workspace)) {
                if (finalized && finalized.column_ids.some(function (id) { return dependencies.required(workspace).includes(id); })) finalized = null;
                await save();
            }
            if (finalized && (!finalized.evidence || finalized.column_ids.some(function (id) { return !workspace.columns.some(function (c) { return String(c.column_id) === id; }); }) ||
                (finalized.evidence.scope_key !== null && finalized.evidence.scope_key !== window.operationsSheet.filterKey(workspace.row_filter)) ||
                (await dependencies.read(workspace, finalized.evidence)).digest !== finalized.evidence.digest)) {
                finalized = null; await save();
            }
            showFinal(); ui.review(workspace);
            return lostTarget;
        }
        function showFinal() { ui.finalRecord(finalized, workspace); }
        function display(preferred, resetMode) {
            similarity.reset();
            var ids = (preferred || lastResults).filter(function (id) { return workspace.columns.some(function (c) { return String(c.column_id) === String(id); }); });
            if (!ids.length) {
                var role = workspace.task_type === "model_normalization" ? "model_spec" : "company_name";
                ids = workspace.columns.filter(function (c) { return c.role === role; }).map(function (c) { return String(c.column_id); });
            }
            if (!ids.length) ids = workspace.columns.slice(0, 1).map(function (c) { return String(c.column_id); });
            ui.current(workspace, target); ui.review(workspace); operations.show(workspace, target, ids, resetMode);
        }
        function change() {
            if (!source) return;
            creationName = null;
            var indexes = ui.mapping();
            var count = new Set(indexes.filter(function (index) { return index >= 0; })).size;
            ready = type === "investigation" ? count === indexes.filter(function (i) { return i >= 0; }).length && count + ui.extras().length > 0 : indexes.length === 3 && count === 3;
            source.mapping = {};
            profiles[type].roles.forEach(function (role, i) { source.mapping[role.key] = indexes[i]; });
            source.reference_columns = ui.extras(); source.task_type = type; source.roles = profiles[type].roles.filter(function (_, i) { return indexes[i] >= 0; }).map(function (r) { return r.key; });
            ui.valid(ready, count, source.reference_columns.length, source.data_row_count);
            ui.status(ready ? "열 구성을 확인한 뒤 작업을 시작하세요. 필터로 숨겨진 행도 복사합니다." : "가져올 열을 선택하고, 역할은 서로 다른 열에 지정하세요.");
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
                if (options.beforeWorkspaceChange) options.beforeWorkspaceChange(null);
                if (!creationName) creationName = profiles[type].prefix + "_" + options.api.newRequestId().replace(/-/g, "").slice(0, 16);
                var next = await window.workspaceCopy.create(source, creationName, function (done, total, phase) { ui.status((phase || "작업표 복사") + " · " + done + "/" + total + "행"); });
                workspace = next; target = next.target; lastResults = []; finalized = null; lastFormula = null;
                var defaultRole = type === "model_normalization" ? "model_spec" : "company_name";
                if (type === "investigation") workspace.advice_subject = "company";
                display(workspace.columns.filter(function (c) {
                    return c.role === defaultRole;
                }).map(function (c) {
                    return String(c.column_id);
                }), true);
                await save();

                ui.hide(); options.complete("작업표를 만들었어. 필요한 정제·수식·범위 변경을 채팅으로 요청해 줘.");
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

            if (options.beforeWorkspaceChange) options.beforeWorkspaceChange(saved);

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
            type = "investigation"; ui.open(type);
            similarity.reset();
            source = null; ready = false; creationName = null;
            workspace = target = null; lastResults = []; lastFormula = null; finalized = null;
            showFinal(); operations.reset(); ui.setup();
        }
        async function open(nextType) {
            var wasBusy = options.isBusy();
            options.enterConversation();
            options.setBusy(true);

            try {
                await save();

                type = workspace ? workspace.task_type : "investigation";
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
        async function changeScope(request, expected, check) {
            check = check || function () {};
            check();
            if (!workspace) throw new Error("먼저 작업 시트를 준비하세요.");
            var sheet = window.operationsSheet;
            if (expected && (expected.workspace_id !== workspace.workspace_id || sheet.filterKey(expected.expected_filter) !== sheet.filterKey(workspace.row_filter))) {
                throw new Error("작업표나 범위가 바뀌었습니다. 범위 변경을 다시 요청하세요.");
            }
            await refresh();
            check();
            if (!["replace", "include", "exclude", "clear"].includes(request.mode)) throw new Error("지원하지 않는 범위 변경입니다.");
            var filter = request.condition;
            if (request.mode !== "clear") {
                if (!filter || !workspace.columns.some(function (c) { return String(c.column_id) === filter.column_id; })) throw new Error("조건 열을 다시 선택하세요.");
                if (!["equals", "not_equals", "contains", "blank", "not_blank"].includes(filter.operator)) throw new Error("조건을 다시 선택하세요.");
                if (typeof filter.value !== "string" || filter.value.length > 32767) throw new Error("비교할 값을 확인하세요.");
                if (!["blank", "not_blank"].includes(filter.operator) && !filter.value.trim()) throw new Error("비교할 값을 입력하세요. 빈 셀은 ‘빈칸’ 조건을 선택하세요.");
            } else if (filter) throw new Error("전체 행으로 돌아갈 때는 조건을 지정하지 마세요.");
            var previous = workspace.row_filter || null, previousTarget = target;
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
            check();
            operations.invalidate(); lastFormula = finalized = null;
            workspace.row_filter = next; target = nextTarget;
            try { await save(); } catch (error) { workspace.row_filter = previous; target = previousTarget; workspace.target = previousTarget; throw error; }
            await refresh();
            display(operations.targets());
            var message = "작업 범위: " + sheet.describeFilter(next, workspace.columns) + " · " + selected.rows.length.toLocaleString() + "행. 셀 값은 변경하지 않았습니다.";
            ui.status(message);
            return message;
        }
        async function manage(action, settings) {
            if (options.isBusy() || !workspace) return;
            options.setBusy(true);
            var imported = 0, previousRoles = null;
            try {
                if (action === "sources" || action === "scope") {
                    if (options.showWorkspace) options.showWorkspace();
                    ui.open(type); ui.mode(action === "sources" ? "import" : "scope");
                }
                // Read form values before refresh repaints the current settings.
                var role = settings, sourceColumns = ui.importSelection(), filter = settings;
                var importPolicy = ui.importPolicy();
                await refresh(); operations.invalidate(); similarity.reset(); lastFormula = null;
                if (action === "scope") {
                    ui.current(workspace, target); ui.status("조건 열과 값을 선택하고 ‘범위 적용’을 누르세요.");
                    return;
                }
                if (action === "scope-apply" || action === "clear-filter") {
                    await changeScope({mode: action === "clear-filter" ? "clear" : "replace", condition: action === "clear-filter" ? null : filter});
                    return;
                } else if (action === "role") {
                    var column = workspace.columns.find(function (c) { return String(c.column_id) === role.column_id; });
                    if (!column) throw new Error("역할을 지정할 열이 없습니다.");
                    if (workspace.task_type !== "investigation" && column.role !== role.role &&
                        profiles[workspace.task_type].roles.some(function (r) { return r.key === column.role; })) {
                        throw new Error("이전 작업표의 필수 역할은 유지해야 합니다. 자유롭게 구성하려면 새 통합 조사를 시작하세요.");
                    }
                    previousRoles = new Map(workspace.columns.map(function (c) { return [String(c.column_id), c.role]; }));
                    if (role.role !== "reference") workspace.columns.forEach(function (c) { if (c.role === role.role) c.role = "reference"; });
                    column.role = role.role;
                } else if (action === "sources") {
                    var available = await window.sourceColumns.list(workspace);
                    ui.importColumns(available);
                    ui.status(available.length ? "추가할 원본 열을 여러 개 선택하고 ‘선택한 열 가져오기’를 누르세요." : "원본 시트에서 추가 가능한 열을 모두 가져왔습니다.");
                    return;
                }
                else if (action === "import") {
                    if (!sourceColumns.length) throw new Error("추가할 원본 열을 선택하세요.");
                    if (workspace.columns.length + sourceColumns.length > 200) throw new Error("작업 표는 최대 200열입니다. 선택한 열 수를 줄이세요.");
                    for (var sourceColumn of sourceColumns) {
                        var result = await window.sourceColumns.append(workspace, sourceColumn.column_id, function (label, done, total) {
                            ui.status("열 가져오기 " + (imported + 1) + "/" + sourceColumns.length + " · " + label + " · " + done + "/" + total);
                        }, Object.assign({}, importPolicy, {header: sourceColumn.header}));
                        workspace.columns = workspace.columns.concat(result.columns);
                        imported++;
                        await save();
                    }
                    await refresh(); ui.importColumns(await window.sourceColumns.list(workspace));
                }
                await save(); display(operations.targets());
                ui.status(action === "import" ? imported + "개 열을 추가했습니다." : "현재 열과 설정으로 작업을 이어갑니다.");
                if (action === "role") options.complete("‘" + column.header + "’ 열의 역할을 변경했어. 셀 값은 그대로야.");
            } catch (error) {
                if (previousRoles) workspace.columns.forEach(function (c) { c.role = previousRoles.get(String(c.column_id)); });
                if (action === "import") {
                    try { ui.importColumns(await window.sourceColumns.list(workspace)); display(operations.targets()); }
                    catch (_) { ui.importColumns([]); }
                }
                ui.status((imported ? imported + "개 열은 추가됐고 나머지는 중단했습니다. " : "") + error.message);
            }
            finally { options.setBusy(false); }
        }
        ui.bind({
        //     groups: async function () {
        //         if (options.isBusy()) return;
        //         options.setBusy(true);
        //         try { await openGroups(); } finally { options.setBusy(false); }
        //     },
            refresh: function () { return manage("refresh"); },
            "import-add": function () { return manage("import"); },
            "role-save": function () { return manage("role"); },
            "clear-filter": function () { return manage("clear-filter"); },
            "scope-clear": function () { return manage("clear-filter"); },
            "scope-apply": function () { return manage("scope-apply"); },
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
                    await options.newInvestigation();
                    ui.open(type);
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
            changeScope: changeScope,
            assignRole: function (settings) { return manage("role", settings); },
            cancelPending: operations.cancel,
            isProcessing: operations.isProcessing,
            recordFinal: operations.finalize,
            openSourceColumns: function () { return manage("sources"); },
            dismiss: function () { ui.hide(); },
            reset: function () { if (groupReview) groupReview.dismiss(); similarity.reset(); source = workspace = target = null; lastResults = []; lastFormula = null; ready = false; finalized = null; showFinal(); operations.reset(); ui.reset(); },
            setBusy: function (busy) { ui.busy(busy, ready); operations.busy(busy); similarity.busy(); if (groupReview) groupReview.busy(busy); },
            referenceTarget: referenceTarget,
            agentInput: async function () {
                if (!workspace || !target) throw new Error("먼저 작업표를 준비하세요.");
                await refresh();
                return {workspace: workspace, target: target};
            },
            context: async function () {
                if (!workspace) return null;
                await refresh();
                var sampleRows = await operations.sampleRows();
                return {workspace_id: workspace.workspace_id, pending_operation: operations.pending(),
                    review_required_column_ids: dependencies.required(workspace),
                    row_filter: workspace.row_filter || null, advice_subject: workspace.advice_subject || (workspace.task_type === "model_normalization" ? "model" : "company"),
                    task_type: workspace.task_type, worksheet_id: workspace.worksheet_id,
                    table_id: String(workspace.table_id), sheet_name: workspace.sheet_name, row_count: target.row_count, row_start: target.row_start,
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
            // openGroups: openGroups, // 묶음 검토 보류(2026-11-18): 재사용 여부 검토 후 불필요하면 삭제. 기존 저장 정보는 보존.
            configureSimilarity: async function (settings) {
                if (!workspace) throw new Error(window.errorMessages.WORKSPACE_SETUP_REQUIRED);
                await refresh();
                await similarity.run(settings);
            },
            previewOperation: function () { return operations.preview(); },
            recommendExtraction: function () { return operations.recommendExtraction(); },
            configure: async function (operation) {
                if (!workspace) throw new Error(window.errorMessages.WORKSPACE_SETUP_REQUIRED);
                await refresh(); display(operation.column_ids); operations.configure(operation); ui.hide();
                ui.status(operation.condition ? "현재 데이터에서 조건에 맞는 행을 확인합니다…" : "현재 데이터로 변경 내용을 계산하고 있어요…");
            },
            recoveryWorkspace: function () { return workspace; },
            recovered: async function (receipt) {
                if (!workspace || workspace.worksheet_id !== receipt.worksheet_id || !receipt.evidence || String(workspace.table_id) !== receipt.evidence.table_id) return;
                await refresh();
                var ids = Array.from(new Set(receipt.evidence.blocks.map(function (b) { return b.column_id; })));
                dependencies.register(workspace, {input_ids: [], output_ids: ids, needs_review: true, full: false, scope_key: null});
                lastResults = ids; finalized = null; ui.review(workspace); await save();
            },
            resolveFormulaOutput: formula.resolveOutput,
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
                        c.role = "result"; c.description = "수식으로 계산 후 값으로 고정한 결과";
                    }
                });
                var record = formula.dependencies();
                if (record && ids.length) {
                    var records = formula.resultDependencies() || await dependencies.formulaResults(workspace, record, formula.plan(), result, selection, ids);
                    records.forEach(function (item) { dependencies.register(workspace, item); });
                    await dependencies.reconcile(workspace);
                }
                lastResults = ids; finalized = null;
                if (ids.length) {
                    target = Object.assign({}, target, {row_start: result.targets[0].row_start, row_count: result.targets[0].row_count}); display(ids, true);
                }
                await save();
            }
        };
    };
})();
