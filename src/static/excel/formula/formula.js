"use strict";

(function () {
    window.createFormulaController = function (options) {
        var ui = options.ui;
        var api = options.api;
        var excel = options.excel;
        var instruction = "";
        var selection = null;
        var formulaJob = null;
        var preview = null;
        var targetSnapshot = null;
        var applied = false;
        var useWorkspace = true;
        var inputScope = null;
        var writeAttempted = false;
        var startTimer = null;

        async function useTarget(target, run) {
            var revised = JSON.parse(JSON.stringify(preview));
            var ranges = target.target_ranges || [target.target_range];
            var anchors = target.anchor_cells || [target.anchor_cell];
            revised.plan.actions.forEach(function (action, index) {
                action.target_range = ranges[index];
                action.anchor_cell = anchors[index];
                action.overwrite = target.overwrite || "reject_nonblank";
            });
            await excel.validateFormulaPreview(revised, selection, target);
            if (run) options.checkRequest(run);
            preview = revised;
            targetSnapshot = target;
            ui.showPreview(instruction, selection, preview, targetSnapshot);
        }

        async function failPreview(message) {
            preview = targetSnapshot = null;
            ui.reset();
            if (formulaJob && formulaJob.preview) {
                try {
                    formulaJob = await api.requestJson("/formula-jobs/" + formulaJob.formula_job_id +
                        "/previews/" + formulaJob.preview.preview_id + "/failed", {
                            method: "POST", headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({error_message: message})
                        });
                } catch (error) {
                    message += " · 서버에 미리보기 실패를 전달하지 못했습니다. 현재 화면에 적용할 미리보기는 없습니다. " + error.message;
                }
            }
            return message;
        }

        async function selectAndPlan() {
            if (options.isBusy() || !instruction) return;
            var run = options.beginRequest();
            options.setBusy(true);
            ui.open();
            ui.setStatus(useWorkspace && inputScope && inputScope.workspace_id
                ? "요청한 입력 열과 작업표의 현재 데이터 행을 확인하고 있습니다…"
                : "Excel에서 선택한 범위를 확인하고 있습니다…");
            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }
                selection = await excel.readFormulaContext(options.getTarget ? await options.getTarget(inputScope, !useWorkspace) : null, inputScope && inputScope.reference_sheet_names || []);
                if (options.validateSource) await options.validateSource(selection, targetSnapshot);
                options.checkRequest(run);
                var names = (selection.input_columns || []).map(function (column) { return column.header; }).join(", ");
                ui.setStatus((names || selection.address) + " · " + selection.row_count.toLocaleString() + "행으로 수식 계획을 만들고 있습니다…");
                if (inputScope && inputScope.output && inputScope.output.name) instruction += "\n결과 열 이름: " + inputScope.output.name;
                var payload = Object.assign({}, selection, {
                    conversation_id: options.getConversationId(),
                    origin_request_id: inputScope && inputScope.origin_request_id || null,
                    formula_job_id: api.newRequestId(),
                    instruction: instruction
                });
                run.request = {
                    conversation_id: payload.conversation_id,
                    request_id: payload.formula_job_id
                };
                formulaJob = await api.requestJson("/formula-jobs", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(payload),
                    signal: run.controller.signal
                });
                options.checkRequest(run);
                if (options.onJobCreated) await options.onJobCreated("formula", formulaJob.formula_job_id);
                formulaJob = await api.requestJson("/formula-jobs/" + formulaJob.formula_job_id + "/analyze", {
                    method: "POST", signal: run.controller.signal
                });
                options.checkRequest(run);
                if (formulaJob.status === "NEEDS_INPUT") {
                    options.complete(formulaJob.clarification || "작업에 필요한 정보를 알려주세요.");
                    return;
                }
                if (formulaJob.status !== "PREVIEW_READY" || !formulaJob.preview) {
                    throw new Error(formulaJob.error || "수식 계획을 만들지 못했습니다.");
                }
                preview = formulaJob.preview;
                var output = inputScope && inputScope.output;
                var destination = output && options.resolveOutput ? await options.resolveOutput(output, selection) : null;
                var prepared = destination ? await excel.readFormulaTarget(preview, selection, destination) : await excel.prepareFormulaPreview(preview, selection);
                options.checkRequest(run);
                await useTarget(prepared, run);
            } catch (error) {
                if (run.cancelled) {
                    await options.reportStop(run);
                    var stopped = await failPreview("수식 계획 생성을 중지했습니다. 셀은 변경하지 않았습니다.");
                    options.complete(stopped, formulaJob && {kind: "formula", job_id: formulaJob.formula_job_id, status: "FAILED"});
                } else {
                    var message = await failPreview(error.message);
                    options.complete(message, formulaJob && {kind: "formula", job_id: formulaJob.formula_job_id, status: "FAILED"});
                }
            } finally {
                options.endRequest(run);
                options.setBusy(false);
            }
        }

        async function selectTarget() {
            if (!preview || applied || options.isBusy()) return;
            options.setBusy(true);
            ui.setStatus("Excel에서 선택한 결과 열을 확인하고 있습니다…");
            try {
                await useTarget(await excel.readFormulaTarget(preview, selection));
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        function selectSource() {
            if (options.isBusy() || applied || writeAttempted) return;
            selection = formulaJob = preview = targetSnapshot = null;
            useWorkspace = false;
            ui.reset();
            return selectAndPlan();
        }

        async function approveAndApply() {
            if (!preview || !targetSnapshot || applied || writeAttempted || options.isBusy()) return;
            options.setBusy(true);
            var approvalRequested = false, recorded = false;
            try {
                if (options.validateSource) await options.validateSource(selection, targetSnapshot);
                await excel.validateFormulaPreview(preview, selection, targetSnapshot);
                approvalRequested = true;
                writeAttempted = true;
                var approved = await api.requestJson(
                    "/formula-jobs/" + formulaJob.formula_job_id + "/previews/" +
                    preview.preview_id + "/approve",
                    {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({
                            overwrite: targetSnapshot.overwrite || "reject_nonblank",
                            target_ranges: preview.plan.actions.map(function (action) {
                                return action.target_range;
                            })
                        })
                    }
                );
                if (approved.preview_id !== preview.preview_id ||
                    JSON.stringify(approved.plan.actions) !== JSON.stringify(preview.plan.actions)) {
                    throw new Error("확인한 계획과 승인된 계획이 다릅니다.");
                }
                if (options.validateSource) await options.validateSource(selection, targetSnapshot);
                await excel.validateFormulaPreview(approved, selection, targetSnapshot);
                if (options.prepareOutput) await options.prepareOutput(approved, selection);
                var result = await excel.applyFormulaPreview(approved, selection, function (label, done, total) {
                    ui.setStatus(label + " · " + done.toLocaleString() + "/" + total.toLocaleString() + "셀");
                }, options.recovery ? options.recovery.formula(formulaJob.formula_job_id, selection, selection.workspace_id ? options.recoveryWorkspace() : null) : null, targetSnapshot);
                applied = true;
                var ids = options.getResultColumns ? await options.getResultColumns(result, selection) : [];
                if (options.recovery && options.onResult) options.recovery.remember(formulaJob.formula_job_id, function () { return options.onResult(result, selection, ids); });
                await api.requestJson(
                    "/formula-jobs/" + formulaJob.formula_job_id + "/previews/" +
                    preview.preview_id + "/complete",
                    {method: "POST", headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({targets: result.targets, result_column_ids: ids})}
                );
                recorded = true;
                ui.setApplied(result);
                if (options.onResult) await options.onResult(result, selection, ids);
                if (options.recovery) options.recovery.completed(formulaJob.formula_job_id);
                options.complete(result.address + " · " + result.row_count + "행에 계산 결과를 값으로 저장했습니다.",
                    {kind: "formula", job_id: formulaJob.formula_job_id, status: "SUCCEEDED"});
            } catch (error) {
                if (approvalRequested && !recorded) {
                    try {
                        await api.requestJson("/formula-jobs/" + formulaJob.formula_job_id + "/previews/" +
                            preview.preview_id + "/unknown", {method: "POST", headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({error_message: error.message})});
                    } catch (statusError) {
                        error.message += " · 서버의 적용 상태를 확인하지 못했습니다. 다시 적용하지 마세요.";
                    }
                }
                if (!approvalRequested) error.message = await failPreview(error.message);
                options.complete((applied ? "결과값은 저장됐지만 완료 정보 처리에 실패했습니다. 다시 쓰지 마세요. " : "") + error.message,
                    {kind: "formula", job_id: formulaJob.formula_job_id, status: approvalRequested ? "UNKNOWN" : "FAILED"});
            } finally {
                options.setBusy(false);
            }
        }

        ui.bind({source: selectSource, target: selectTarget, apply: approveAndApply, cancel: async function () {
            options.setBusy(true);
            try {
                var message = await failPreview('수식 적용을 취소했어.');
                if (formulaJob) options.complete(message, {kind: 'formula', job_id: formulaJob.formula_job_id, status: 'FAILED'});
            } finally { options.setBusy(false); }
        }});
        return {
            changeOutput: async function (action) {
                if (!formulaJob || formulaJob.formula_job_id !== action.formula_job_id || !preview || applied || writeAttempted) throw new Error('변경할 수식 미리보기가 없어. 작업을 다시 요청해 줘.');
                options.setBusy(true);
                try {
                    ui.reset();
                    if (action.output.name) throw new Error('수식 결과 이름을 바꾸려면 원하는 이름과 함께 수식 작업을 다시 요청해 줘.');
                    var destination = await options.resolveOutput(action.output, selection);
                    if (!destination) {
                        preview = formulaJob.preview;
                        await useTarget(await excel.prepareFormulaPreview(preview, selection));
                    } else await useTarget(await excel.readFormulaTarget(preview, selection, destination));
                } catch (error) {
                    throw new Error(await failPreview(error.message));
                } finally { options.setBusy(false); }
            },
            dismiss: function () { window.clearTimeout(startTimer); ui.reset(); },
            openAndSelect: function (value, scope) {
                instruction = value;
                inputScope = scope || null;
                selection = formulaJob = preview = targetSnapshot = null;
                applied = false;
                writeAttempted = false;
                useWorkspace = true;
                ui.reset();
                ui.open();
                ui.setStatus(inputScope && inputScope.workspace_id
                    ? "요청한 열을 작업표에서 찾고 있습니다…" : "Excel에서 선택한 범위를 가져옵니다…");
                startTimer = window.setTimeout(selectAndPlan, 0);
            },
            reset: function () {
                window.clearTimeout(startTimer);
                instruction = "";
                inputScope = null;
                selection = formulaJob = preview = targetSnapshot = null;
                applied = false;
                writeAttempted = false;
                useWorkspace = true;
                ui.reset();
            },
            setBusy: function (busy) {
                ui.setBusy(busy, Boolean(preview), applied || writeAttempted);
            }
        };
    };
})();
