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

        function open() {
            chat.enterConversation();
            panel.hidden = false;
            if (!chat.conversation.contains(panel)) chat.conversation.appendChild(panel);
            chat.scrollArea.scrollTop = chat.scrollArea.scrollHeight;
        }

        function clearResult() {
            // 과거 분석 메시지는 대화에 남겨둔다.
            resultText = null;
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
            sourceText.textContent = selection.address + " · 데이터 " +
                (selection.row_count - 1) + "행 · 앞부분 표본 " + selection.samples.length + "행";
            preview.textContent = [selection.headers.join(" | ")].concat(
                selection.samples.map(function (row) { return row.cells.join(" | "); })
            ).join("\n");
            mappingPanel.hidden = false;
            selectButton.textContent = "다시 선택";
            statusText.textContent = "세 열의 역할을 확인한 뒤 LLM 확인을 눌러주세요.";
        }

        function renderJob(job) {
            var labels = {
                CREATED: "작업 생성됨",
                ANALYZING: "LLM 확인 중",
                REVIEW_READY: "표본 확인 완료 · 규칙 승인 전",
                FAILED: "확인 실패"
            };
            statusText.textContent = labels[job.status] + " · 작업 " + job.job_id;
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

        return {
            open: open,
            reset: reset,
            archive: archive,
            beginSelection: beginSelection,
            showSelection: showSelection,
            clearResult: clearResult,
            renderJob: renderJob,
            setStatus: function (text) { statusText.textContent = text; },
            getMapping: function () {
                return selects.map(function (select) { return Number(select.value); });
            },
            setBusy: function (busy, hasPayload) {
                selectButton.disabled = busy;
                analyzeButton.disabled = busy;
                refreshButton.disabled = busy || !hasPayload;
                selects.forEach(function (select) { select.disabled = busy; });
            },
            bind: function (handlers) {
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
