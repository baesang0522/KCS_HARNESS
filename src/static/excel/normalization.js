"use strict";

(function () {
    // 선택·분석 흐름과 재시도할 요청만 관리한다. DOM과 Excel 접근은 분리한다.
    window.createNormalizationController = function (options) {
        var ui = options.ui;
        var api = options.api;
        var excel = options.excel;
        var selection = null;
        var payload = null;
        var currentPreview = null;
        var exported = false;
        var workspace = null;
        var workspaceTarget = null;
        var creationName = null;
        var transform = window.createNormalizationTransform({
            api: api,
            isBusy: options.isBusy,
            setBusy: options.setBusy,
            setStatus: ui.setStatus,
            onResult: function (currentWorkspace, nextTarget) {
                workspace = currentWorkspace;
                workspaceTarget = nextTarget;
                showWorkspace();
            }
        });

        function showWorkspace() {
            ui.showWorkspace(workspace, workspaceTarget);
            transform.show(workspace, workspaceTarget);
        }

        async function renderJobWithPreview(job) {
            ui.renderJob(job);

            if (job.status === "REVIEW_READY") {
                ui.showRuleSelector(job.rule_examples || {});
            }
        }

        function invalidatePreview() {
            currentPreview = null;
            exported = false;

            ui.clearPreview();
            ui.setBusy(options.isBusy(), payload !== null);
            ui.setStatus(
                "규칙 선택이 변경되었습니다. 미리보기를 다시 생성하세요."
            );
        }

        async function rebuildPreview() {
            if (options.isBusy() || !payload) return;

            var rules = ui.getSelectedRules();

            if (!rules.length) {
                ui.setStatus("적용할 규칙을 하나 이상 선택하세요.");
                return;
            }

            options.setBusy(true);
            currentPreview = null;
            exported = false;
            ui.clearPreview();

            try {
                ui.setStatus("선택한 규칙으로 전체 미리보기를 생성하고 있습니다…");

                var preview = await api.requestJson(
                    "/jobs/" + payload.job_id + "/preview",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ rules: rules })
                    }
                );

                ui.showExportPreview(preview);
                currentPreview = preview;

                ui.setStatus(
                    "미리보기를 확인한 뒤 결과를 승인하세요."
                );
            } catch (error) {
                currentPreview = null;
                ui.clearPreview();
                ui.setStatus("미리보기 생성 실패: " + error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function exportPreview() {
            if (
                options.isBusy() || !payload ||
                !currentPreview || exported
            ) return;

            options.setBusy(true);

            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }

                var approved = await api.requestJson(
                    "/jobs/" + payload.job_id +
                    "/previews/" + currentPreview.preview_id + "/approve",
                    { method: "POST" }
                );

                if (approved.preview_id !== currentPreview.preview_id) {
                    throw new Error("확인한 결과와 승인된 결과가 다릅니다.");
                }

                var result = await excel.writeNormalizationPreview(approved);

                exported = true;
                ui.setExported(result);
                ui.setStatus(
                    result.sheet_name + "에 선택 영역 전체 " +
                    result.row_count + "행을 출력했습니다."
                );
            } catch (error) {
                ui.setStatus("출력 실패: " + error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function selectRange() {
            if (options.isBusy()) return;
            ui.open();
            options.setBusy(true);
            ui.setStatus("Excel에서 선택한 범위를 확인하고 있습니다…");
            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }
                if (workspace) {
                    var nextTarget = await window.normalizationSheet.readWorkspaceTarget(workspace);
                    if (nextTarget) {
                        workspaceTarget = nextTarget;
                        currentPreview = null;
                        ui.clearResult();
                        showWorkspace();
                        ui.setStatus("현재 선택한 범위로 변경했습니다. 시트의 수정 내용은 유지됩니다.");
                        return;
                    }
                }
                var nextSelection = await window.normalizationSheet.readSource();
                if (nextSelection.column_count < 3) {
                    throw new Error("필수 열을 지정할 수 있도록 세 열 이상 선택하세요.");
                }

                // 새 범위를 읽지 못하면 기존 열 설정과 설명을 유지한다.
                if (selection) ui.archive();
                ui.beginSelection();
                transform.hide();
                selection = nextSelection;
                workspaceTarget = null;
                payload = null;
                currentPreview = null;
                exported = false;
                ui.showSelection(selection);
                updateColumnSelection();
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function createWorkspace() {
            if (options.isBusy() || !selection || !selection.mapping) return;
            options.setBusy(true);
            ui.setStatus("작업 시트를 만드는 중입니다. 복사가 끝날 때까지 원본 편집을 기다려 주세요.");
            try {
                if (!options.isReady()) throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                // 같은 요청 재시도에서 새 시트를 중복 생성하지 않는다.
                if (!creationName) creationName = "모델규격_" + api.newRequestId().replace(/-/g, "").slice(0, 16);
                workspace = await window.normalizationWorkspace.create(
                    selection, creationName, function (done, total) {
                        ui.setStatus("작업 시트 복사 중 · " + done.toLocaleString() +
                            " / " + total.toLocaleString() + "행");
                    }
                );
                workspaceTarget = workspace.target;
                showWorkspace();
                ui.setStatus("작업 시트를 만들었습니다. 시트에서 직접 수정하거나 범위를 다시 선택하세요.");
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function returnWorkspace() {
            if (options.isBusy() || !workspace) return;
            options.setBusy(true);
            try {
                workspaceTarget = await window.normalizationSheet.readWorkspaceTarget(workspace, true);
                currentPreview = null;
                ui.clearResult();
                showWorkspace();
                ui.setStatus("작업 시트로 이동했습니다. 현재 값을 기준으로 이어서 작업할 수 있습니다.");
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function analyze() {
            if (!selection || !selection.rows || options.isBusy()) return;
            options.setBusy(true);
            try {
                var indexes = ui.getMapping();
                if (new Set(indexes).size !== 3) {
                    throw new Error("거래품명·신고품명·모델규격에 서로 다른 열을 지정하세요.");
                }
                if (!payload) {
                    var conversationId = options.getConversationId();
                    if (!conversationId) throw new Error("먼저 새 대화를 시작해 주세요.");
                    // 응답 유실 후 재시도할 때도 같은 Job ID와 입력을 사용한다.
                    payload = Object.assign({}, selection, {
                        conversation_id: conversationId,
                        job_id: api.newRequestId(),
                        mapping: {
                            trade_name: indexes[0],
                            declared_name: indexes[1],
                            model_spec: indexes[2]
                        }
                    });
                }
                ui.setStatus("작업 생성 중…");
                var job = await api.requestJson("/jobs", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                await renderJobWithPreview(job);
                ui.setStatus("선택 영역 전체를 나눠 분석한 뒤 결과를 종합하고 있습니다…");
                job = await api.requestJson(
                    "/jobs/" + payload.job_id + "/analyze",
                    { method: "POST" }
                );
                await renderJobWithPreview(job);
            } catch (error) {
                ui.setStatus(error.message + " 작업 상태 조회 또는 재시도를 해주세요.");
            } finally {
                options.setBusy(false);
            }
        }

        async function refresh() {
            if (!payload || options.isBusy()) return;
            options.setBusy(true);
            try {
                var job = await api.requestJson("/jobs/" + payload.job_id);
                await renderJobWithPreview(job);
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        function updateColumnSelection() {
            creationName = null;
            ui.setCreateReady(false);
            payload = null;
            currentPreview = null;
            exported = false;
            ui.clearResult();
            ui.setBusy(options.isBusy(), false);
            if (!selection) return;

            // 추후 작업 시트 생성과 LLM 입력에서 열 설명을 함께 사용한다.
            selection.reference_columns = ui.getExtraColumns();
            selection.mapping = null;
            var indexes = ui.getMapping();
            if (indexes.some(function (index) { return index < 0; })) {
                ui.setStatus("필수 세 열을 모두 선택하세요.");
                return;
            }
            if (new Set(indexes).size !== 3) {
                ui.setStatus("필수 세 역할에는 서로 다른 열을 지정하세요.");
                return;
            }
            selection.mapping = {
                trade_name: indexes[0],
                declared_name: indexes[1],
                model_spec: indexes[2]
            };
            ui.setCreateReady(true);
            ui.setStatus(
                "필수 3개 열 · 추가 " + selection.reference_columns.length +
                "개 열 선택됨. 추가 열의 설명은 선택 사항입니다."
            );
        }

        ui.bind({
            select: selectRange,
            createWorkspace: createWorkspace,
            returnWorkspace: returnWorkspace,
            analyze: analyze,
            refresh: refresh,
            export: exportPreview,

            preview: rebuildPreview,
            rulesChange: invalidatePreview,

            mappingChange: updateColumnSelection
        });

        return {
            open: ui.open,
            reset: function () {
                workspace = null;
                workspaceTarget = null;
                creationName = null;
                selection = null;
                payload = null;
                currentPreview = null;
                exported = false;
                transform.reset();
                ui.reset();
            },
            getWorkspaceContext: function () {
                return {workspace: workspace, target: workspaceTarget};
            },
            setBusy: function (busy) {
                ui.setBusy(busy, payload !== null);
                transform.setBusy(busy);
            }
        };
    };
})();
