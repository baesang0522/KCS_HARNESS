"use strict";

(function () {
    // 선택·분석 흐름과 재시도할 요청만 관리한다. DOM과 Excel 접근은 분리한다.
    window.createNormalizationController = function (options) {
        var ui = options.ui;
        var api = options.api;
        var excel = options.excel;
        var selection = null;
        var payload = null;

        async function selectRange() {
            if (options.isBusy()) return;
            if (selection) ui.archive();
            ui.beginSelection();
            selection = null;
            payload = null;
            options.setBusy(true);
            try {
                if (!options.isReady()) {
                    throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
                }
                selection = await excel.readNormalizationSample();
                ui.showSelection(selection);
            } catch (error) {
                selection = null;
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        async function analyze() {
            if (!selection || options.isBusy()) return;
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
                var job = await api.requestJson("/normalization/jobs", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                ui.renderJob(job);
                ui.setStatus("LLM이 표본을 확인하고 있습니다…");
                job = await api.requestJson(
                    "/normalization/jobs/" + payload.job_id + "/analyze",
                    { method: "POST" }
                );
                ui.renderJob(job);
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
                var job = await api.requestJson("/normalization/jobs/" + payload.job_id);
                ui.renderJob(job);
            } catch (error) {
                ui.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        ui.bind({
            select: selectRange,
            analyze: analyze,
            refresh: refresh,
            mappingChange: function () {
                payload = null;
                ui.clearResult();
                ui.setBusy(options.isBusy(), false);
                ui.setStatus("열 역할 변경됨 · 다시 확인하세요.");
            }
        });

        return {
            open: ui.open,
            reset: function () {
                selection = null;
                payload = null;
                ui.reset();
            },
            setBusy: function (busy) { ui.setBusy(busy, payload !== null); }
        };
    };
})();
