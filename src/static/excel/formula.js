"use strict";

(function () {
    window.createFormulaController = function (options) {
        var ui = options.ui;
        var api = options.api;
        var excel = options.excel;
        var instruction = "";
        var selection = null;
        var job = null;
        var preview = null;
        var targetSnapshot = null;
        var applied = false;

        async function useTarget(target) {
            var revised = JSON.parse(JSON.stringify(preview));
            var ranges = target.target_ranges || [target.target_range];
            var anchors = target.anchor_cells || [target.anchor_cell];
            revised.plan.actions.forEach(function (action, index) {
                action.target_range = ranges[index];
                action.anchor_cell = anchors[index];
            });
            await excel.validateFormulaPreview(revised, selection);
            preview = revised;
            targetSnapshot = target;
            ui.showPreview(instruction, selection, preview, targetSnapshot);
        }

        async function selectAndPlan() {
            if (options.isBusy() || !instruction) return;
            options.setBusy(true);
            ui.open();
            ui.setStatus("선택 범위를 확인하고 있습니다…");
            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }
                selection = await excel.readFormulaContext();
                var payload = Object.assign({}, selection, {
                    conversation_id: options.getConversationId(),
                    job_id: api.newRequestId(),
                    instruction: instruction
                });
                job = await api.requestJson("/jobs", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(payload)
                });
                job = await api.requestJson("/jobs/" + job.job_id + "/analyze", {
                    method: "POST"
                });
                if (job.status === "NEEDS_INPUT") {
                    ui.setStatus(job.clarification || "작업에 필요한 정보를 알려주세요.");
                    return;
                }
                if (job.status !== "PREVIEW_READY" || !job.preview) {
                    throw new Error(job.error || "수식 계획을 만들지 못했습니다.");
                }
                preview = job.preview;
                await useTarget(await excel.prepareFormulaPreview(preview, selection));
            } catch (error) {
                if (!targetSnapshot) preview = null;
                ui.setStatus(error.message);
            } finally {
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
            selection = job = preview = targetSnapshot = null;
            ui.reset();
            return selectAndPlan();
        }

        async function approveAndApply() {
            if (!preview || !targetSnapshot || applied || options.isBusy()) return;
            options.setBusy(true);
            try {
                var approved = await api.requestJson(
                    "/jobs/" + job.job_id + "/previews/" +
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
                var result = await excel.applyFormulaPreview(approved, selection);
                await api.requestJson(
                    "/jobs/" + job.job_id + "/previews/" +
                    preview.preview_id + "/complete",
                    {method: "POST"}
                );
                applied = true;
                ui.setApplied(result);
            } catch (error) {
                ui.setStatus("수식 적용 실패: " + error.message);
            } finally {
                options.setBusy(false);
            }
        }

        ui.bind({source: selectSource, target: selectTarget, apply: approveAndApply});
        return {
            openAndSelect: function (value) {
                instruction = value;
                selection = job = preview = targetSnapshot = null;
                applied = false;
                ui.reset();
                ui.open();
                ui.setStatus("Excel에서 선택한 범위를 가져옵니다…");
                window.setTimeout(selectAndPlan, 0);
            },
            reset: function () {
                instruction = "";
                selection = job = preview = targetSnapshot = null;
                applied = false;
                ui.reset();
            },
            setBusy: function (busy) {
                ui.setBusy(busy, Boolean(preview), applied);
            }
        };
    };
})();
