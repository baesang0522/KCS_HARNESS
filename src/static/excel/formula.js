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
        var writeAttempted = false;
        var startTimer = null;

        async function useTarget(target, run) {
            var revised = JSON.parse(JSON.stringify(preview));
            var ranges = target.target_ranges || [target.target_range];
            var anchors = target.anchor_cells || [target.anchor_cell];
            revised.plan.actions.forEach(function (action, index) {
                action.target_range = ranges[index];
                action.anchor_cell = anchors[index];
            });
            await excel.validateFormulaPreview(revised, selection);
            if (run) options.checkRequest(run);
            preview = revised;
            targetSnapshot = target;
            ui.showPreview(instruction, selection, preview, targetSnapshot);
        }

        async function selectAndPlan() {
            if (options.isBusy() || !instruction) return;
            var run = options.beginRequest();
            options.setBusy(true);
            ui.open();
            ui.setStatus("선택 범위를 확인하고 있습니다…");
            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }
                selection = await excel.readFormulaContext(useWorkspace && options.getTarget ? await options.getTarget() : null);
                options.checkRequest(run);
                var payload = Object.assign({}, selection, {
                    conversation_id: options.getConversationId(),
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
                var prepared = await excel.prepareFormulaPreview(preview, selection);
                options.checkRequest(run);
                await useTarget(prepared, run);
            } catch (error) {
                if (run.cancelled) {
                    preview = targetSnapshot = null;
                    await options.reportStop(run);
                    options.complete("수식 계획 생성을 중지했습니다. 셀은 변경하지 않았습니다.");
                } else {
                    if (!targetSnapshot) preview = null;
                    options.complete(error.message);
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
            if (options.isBusy() || applied) return;
            selection = formulaJob = preview = targetSnapshot = null;
            useWorkspace = false;
            ui.reset();
            return selectAndPlan();
        }

        async function approveAndApply() {
            if (!preview || !targetSnapshot || applied || writeAttempted || options.isBusy()) return;
            options.setBusy(true);
            try {
                var approved = await api.requestJson(
                    "/formula-jobs/" + formulaJob.formula_job_id + "/previews/" +
                    preview.preview_id + "/approve",
                    {
                        method: "POST",
                        headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({
                            target_ranges: preview.plan.actions.map(function (action) {
                                return action.target_range;
                            })
                        })
                    }
                );
                if (approved.preview_id !== preview.preview_id) {
                    throw new Error("확인한 계획과 승인된 계획이 다릅니다.");
                }
                await excel.validateFormulaPreview(approved, selection);
                writeAttempted = true;
                if (options.prepareOutput) await options.prepareOutput(approved, selection);
                var result = await excel.applyFormulaPreview(approved, selection);
                applied = true;
                ui.setApplied(result);
                if (options.onResult) await options.onResult(result, selection);
                await api.requestJson(
                    "/formula-jobs/" + formulaJob.formula_job_id + "/previews/" +
                    preview.preview_id + "/complete",
                    {method: "POST"}
                );
                options.complete(result.address + " · " + result.row_count + "행에 수식을 적용했습니다.");
            } catch (error) {
                options.complete((applied ? "수식은 작성됐지만 완료 정보 처리에 실패했습니다. 다시 쓰지 마세요. " : "수식 적용 실패: ") + error.message);
            } finally {
                options.setBusy(false);
            }
        }

        ui.bind({source: selectSource, target: selectTarget, apply: approveAndApply});
        return {
            dismiss: function () { window.clearTimeout(startTimer); ui.reset(); },
            openAndSelect: function (value) {
                instruction = value;
                selection = formulaJob = preview = targetSnapshot = null;
                applied = false;
                writeAttempted = false;
                useWorkspace = true;
                ui.reset();
                ui.open();
                ui.setStatus("Excel에서 선택한 범위를 가져옵니다…");
                startTimer = window.setTimeout(selectAndPlan, 0);
            },
            reset: function () {
                window.clearTimeout(startTimer);
                instruction = "";
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
