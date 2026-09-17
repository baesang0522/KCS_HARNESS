"use strict";

(function () {
    // DOM 표시와 입력만 담당한다. Excel·HTTP 요청과 Job 상태는 컨트롤러에 둔다.
    window.createNormalizationUI = function (chat) {
        var selectButton = document.getElementById("norm-select");
        var analyzeButton = document.getElementById("norm-analyze");
        var refreshButton = document.getElementById("norm-refresh");
        var attachButton = document.getElementById("attach-range");
        var panel = document.getElementById("normalization-panel");
        var mappingPanel = document.getElementById("norm-mapping");
        var sourceText = document.getElementById("norm-source");
        var preview = document.getElementById("norm-preview");
        var statusText = document.getElementById("norm-status");
        var selects = ["norm-trade", "norm-declared", "norm-spec"].map(function (id) {
            return document.getElementById(id);
        });
        var roles = ["거래품명", "신고품명", "모델규격"];
        var resultText = null;
        var exportButton = null;
        var exported = false;
        var exportHandler = null;
        var exportPanel = null;

        function open() {
            chat.enterConversation();
            panel.hidden = false;
            if (!chat.conversation.contains(panel)) chat.conversation.appendChild(panel);
            chat.scrollArea.scrollTop = chat.scrollArea.scrollHeight;
        }

        function clearResult() {
            // 과거 분석 메시지는 대화에 남겨둔다.
            if (exportButton) exportButton.disabled = true;

            resultText = null;
            exportButton = null;
            exportPanel = null;
            exported = false;
        }

        function reset() {
            panel.hidden = true;
            // 대화 내용을 비우기 전에 재사용할 선택 카드를 바깥으로 옮긴다.
            chat.scrollArea.appendChild(panel);
            clearResult();
            mappingPanel.hidden = true;
            statusText.textContent = "";
            sourceText.textContent = "";
            preview.textContent = "";
            refreshButton.disabled = true;
            selectButton.textContent = "선택 범위 가져오기";
        }

        function archive() {
            var summary = chat.appendMessage("user", sourceText.textContent + "\n" +
                selects.map(function (select, index) {
                    return roles[index] + ": " + select.options[select.selectedIndex].textContent;
                }).join("\n"));
            summary.classList.add("range-summary");
            chat.conversation.insertBefore(summary, panel);
        }

        function beginSelection() {
            open();
            chat.conversation.appendChild(panel);
            mappingPanel.hidden = true;
            refreshButton.disabled = true;
            clearResult();
        }

        function showSelection(selection) {
            selects.forEach(function (select, roleIndex) {
                select.textContent = "";
                selection.headers.forEach(function (header, index) {
                    var option = document.createElement("option");
                    option.value = String(index);
                    option.textContent = (index + 1) + "번째 열 · " + (header || "(머리글 없음)");
                    select.appendChild(option);
                });
                var matched = selection.headers.findIndex(function (header) {
                    return header.trim() === roles[roleIndex];
                });
                select.value = String(matched >= 0 ? matched : roleIndex);
            });
            sourceText.textContent =
                selection.address + " · 전체 데이터 " +
                selection.rows.length + "행";

            preview.textContent = [selection.headers.join(" | ")].concat(
                selection.rows.slice(0, 20).map(function (row) {
                    return row.cells.join(" | ");
                })
            ).join("\n");
            mappingPanel.hidden = false;
            selectButton.textContent = "다시 선택";
            statusText.textContent = "세 열의 역할을 확인한 뒤 LLM 확인을 눌러주세요.";
        }

        function renderJob(job) {
            var labels = {
                CREATED: "작업 생성됨",
                ANALYZING: "전체 데이터 분석 중",
                REVIEW_READY: "전체 분석 완료 · 결과 승인 전",
                PREVIEWING: "전체 정제 미리보기 생성 중",
                FAILED: "확인 실패"
            };

            statusText.textContent = labels[job.status] + " · 작업 " + job.job_id;

            if (job.status === "ANALYZING") {
                statusText.textContent += job.analysis_phase === "COMBINING"
                    ? " · 분석 결과 종합 중"
                    : " · " + job.analyzed_row_count +
                      "/" + job.data_row_count + "행 분석";
            }

            if (job.status === "PREVIEWING") {
                statusText.textContent +=
                    " · " + job.processed_row_count +
                    "/" + job.data_row_count + "행 정제";
            }

            if (job.status === "REVIEW_READY") {
                if (!resultText) {
                    resultText = chat.appendMessage("assistant", job.analysis).querySelector("p");
                } else {
                    resultText.textContent = job.analysis;
                }
                mappingPanel.hidden = true;
                selectButton.textContent = "다시 선택";
                statusText.textContent = sourceText.textContent + " · 범위·열 설정 확인됨";
                analyzeButton.textContent = "이 설정으로 확인";
            } else if (job.error) {
                statusText.textContent = job.error;
            }
        }
        function showExportPreview(data) {
            if (exportPanel) exportPanel.remove();

            exportPanel = document.createElement("section");
            exportPanel.className = "norm-result-preview";

            var title = document.createElement("h3");
            title.textContent = "정제 결과 미리보기";
            exportPanel.appendChild(title);

            var summary = document.createElement("p");
            summary.textContent =
                "선택 영역 전체 " + data.row_count +
                "행 중 " + data.changed_count + "행 변경";
            exportPanel.appendChild(summary);

            // DOM에 전체 결과를 만들지 않고 변경 예시만 표시한다.
            var examples = [];
            for (var index = 0; index < data.rows.length; index += 1) {
                if (data.rows[index].changed) {
                    examples.push(data.rows[index]);
                    if (examples.length === 50) break;
                }
            }

            if (examples.length) {
                var details = document.createElement("details");
                var toggle = document.createElement("summary");
                toggle.textContent =
                    "변경 예시 " + examples.length +
                    "행 보기 · 전체 변경 " + data.changed_count + "행";
                details.appendChild(toggle);

                examples.forEach(function (row) {
                    var card = document.createElement("div");
                    card.className = "norm-preview-row is-changed";

                    var label = document.createElement("p");
                    label.textContent = "원본 " + row.excel_row + "행";
                    card.appendChild(label);

                    var beforeAfter = document.createElement("pre");
                    beforeAfter.textContent =
                        "전: " + JSON.stringify(row.original_model_spec) + "\n" +
                        "후: " + JSON.stringify(row.normalized_model_spec);
                    card.appendChild(beforeAfter);

                    details.appendChild(card);
                });

                exportPanel.appendChild(details);
            }

            var note = document.createElement("p");
            note.className = "norm-preview-note";
            note.textContent =
                "전체에 동일한 앞뒤 공백 제거·연속 공백 통일 규칙을 적용했습니다. " +
                "승인하면 변경되지 않은 행을 포함한 전체 " +
                data.row_count + "행을 새 시트에 출력합니다. 원본은 유지합니다.";
            exportPanel.appendChild(note);

            exported = false;
            exportButton = document.createElement("button");
            exportButton.type = "button";
            exportButton.className = "norm-preview-button";
            exportButton.textContent = "전체 결과 승인 후 새 시트에 쓰기";
            exportButton.disabled = true;
            exportButton.addEventListener("click", function () {
                if (exportHandler) exportHandler();
            });
            exportPanel.appendChild(exportButton);

            resultText.parentElement.appendChild(exportPanel);
        }
        return {
            open: open,
            reset: reset,
            archive: archive,
            beginSelection: beginSelection,
            showSelection: showSelection,
            clearResult: clearResult,
            renderJob: renderJob,
            setStatus: function (text) { statusText.textContent = text; },
            showExportPreview: showExportPreview,
            setExported: function (result) {
                exported = true;
                exportButton.disabled = true;
                exportButton.textContent =
                    result.sheet_name + " · " + result.row_count + "행 출력 완료";
            },
            getMapping: function () {
                return selects.map(function (select) { return Number(select.value); });
            },
            setBusy: function (busy, hasPayload) {
                selectButton.disabled = busy;
                analyzeButton.disabled = busy;
                refreshButton.disabled = busy || !hasPayload;
                selects.forEach(function (select) { select.disabled = busy; });
                if (exportButton) { exportButton.disabled = busy || exported; }
            },
            bind: function (handlers) {
                exportHandler = handlers.export;
                selectButton.addEventListener("click", handlers.select);
                attachButton.addEventListener("click", handlers.select);
                analyzeButton.addEventListener("click", handlers.analyze);
                refreshButton.addEventListener("click", handlers.refresh);
                selects.forEach(function (select) {
                    select.addEventListener("change", handlers.mappingChange);
                });
            }
        };
    };
})();
