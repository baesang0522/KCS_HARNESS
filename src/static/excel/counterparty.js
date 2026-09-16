"use strict";

(function () {
    window.createCounterpartyController = function (options) {
        var ui = options.ui;
        var selection = null;
        var payload = null;
        var canReview = false;
        var canApprove = false;
        var currentPreview = null;
        var exported = false;

        function render(job) {
            canReview = job.status !== "REVIEW_READY" && job.candidate_groups.length > 0;
            canApprove = job.status === "REVIEW_READY" && job.final_candidates.length > 0;
            ui.renderJob(job);
        }
        function clearApproval() {
            currentPreview = null;
            exported = false;
            ui.clearApprovalPreview();
        }
        async function selectRange() {
            if (options.isBusy()) return;
            ui.beginSelection();
            selection = payload = null;
            canReview = canApprove = false;
            clearApproval();
            options.setBusy(true);
            try {
                if (!options.isReady()) throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                selection = await options.excel.readCounterpartyRows();
                ui.showSelection(selection);
            } catch (error) {
                selection = null;
                ui.setStatus(error.message);
            } finally { options.setBusy(false); }
        }
        async function create() {
            if (!selection || options.isBusy()) return;
            options.setBusy(true);
            try {
                var indexes = ui.getMapping();
                if (new Set(indexes).size !== 3) throw new Error("부호·국가·상호에 서로 다른 열을 지정하세요.");
                if (!payload) payload = Object.assign({}, selection, {
                    conversation_id: options.getConversationId(),
                    job_id: options.api.newRequestId(),
                    mapping: {party_code: indexes[0], country_code: indexes[1], company_name: indexes[2]}
                });
                var job = await options.api.requestJson("/jobs", {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(payload)
                });
                clearApproval();
                render(job);
            } catch (error) { ui.setStatus(error.message); }
            finally { options.setBusy(false); }
        }
        async function review() {
            if (!payload || !canReview || options.isBusy()) return;
            options.setBusy(true);
            ui.setStatus("모델이 후보를 검토하고 있습니다…");
            try {
                var job = await options.api.requestJson(
                    "/jobs/" + payload.job_id + "/analyze?conversation_id=" +
                    encodeURIComponent(payload.conversation_id), {method: "POST"}
                );
                clearApproval();
                render(job);
            } catch (error) { ui.setStatus(error.message); }
            finally { options.setBusy(false); }
        }
        async function refresh() {
            if (!payload || options.isBusy()) return;
            options.setBusy(true);
            try {
                var job = await options.api.requestJson(
                    "/jobs/" + payload.job_id + "?conversation_id=" +
                    encodeURIComponent(payload.conversation_id)
                );
                clearApproval();
                render(job);
            } catch (error) { ui.setStatus(error.message); }
            finally { options.setBusy(false); }
        }
        async function previewApproval() {
            if (!payload || !canApprove || options.isBusy()) return;
            options.setBusy(true);
            try {
                currentPreview = await options.api.requestJson(
                    "/jobs/" + payload.job_id + "/preview", {
                        method: "POST", headers: {"Content-Type": "application/json"},
                        body: JSON.stringify({decisions: ui.getDecisions()})
                    }
                );
                exported = false;
                ui.showApprovalPreview(currentPreview);
            } catch (error) { ui.setStatus("미리보기 실패: " + error.message); }
            finally { options.setBusy(false); }
        }
        async function exportPreview() {
            if (!payload || !currentPreview || exported || options.isBusy()) return;
            options.setBusy(true);
            try {
                if (!options.isReady()) throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                var approved = await options.api.requestJson(
                    "/jobs/" + payload.job_id + "/previews/" +
                    currentPreview.preview_id + "/approve", {method: "POST"}
                );
                if (approved.preview_id !== currentPreview.preview_id) {
                    throw new Error("확인한 결과와 승인된 결과가 다릅니다.");
                }
                var result = await options.excel.writeCounterpartyPreview(approved);
                exported = true;
                ui.setExported(result);
                ui.setStatus(result.sheet_name + "에 승인 결과 " + result.row_count + "행을 출력했습니다.");
            } catch (error) { ui.setStatus("반영 실패: " + error.message); }
            finally { options.setBusy(false); }
        }

        ui.bind({
            select: selectRange, create: create, review: review, refresh: refresh,
            preview: previewApproval, export: exportPreview,
            decisionChange: clearApproval,
            mappingChange: function () {
                payload = null; canReview = canApprove = false; clearApproval();
                ui.setStatus("열 역할 변경됨 · 다시 확인하세요.");
            }
        });
        return {
            openAndSelect: function () { ui.open(); window.setTimeout(selectRange, 0); },
            reset: function () {
                selection = payload = null; canReview = canApprove = false;
                currentPreview = null; exported = false; ui.reset();
            },
            setBusy: function (busy) {
                ui.setBusy(busy, payload !== null, canReview, canApprove,
                    currentPreview !== null, exported);
            }
        };
    };
})();
