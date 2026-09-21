"use strict";

(function () {
    window.createFormulaUI = function (chat) {
        var panel = document.getElementById("formula-panel");
        var requestText = document.getElementById("formula-request");
        var previewText = document.getElementById("formula-preview");
        var status = document.getElementById("formula-status");
        var sourceAddress = document.getElementById("formula-source-address");
        var targetRow = document.getElementById("formula-target-row");
        var targetAddress = document.getElementById("formula-target-address");
        var sourceChange = document.getElementById("formula-source-change");
        var targetChange = document.getElementById("formula-target-change");
        var applyButton = document.getElementById("formula-apply");
        var multiple = false;

        function open() {
            chat.enterConversation();
            panel.hidden = false;
            if (!chat.conversation.contains(panel)) chat.conversation.appendChild(panel);
        }
        function reset() {
            panel.hidden = true;
            chat.scrollArea.appendChild(panel);
            requestText.textContent = previewText.textContent = status.textContent = "";
            sourceAddress.textContent = "선택 필요";
            targetAddress.textContent = "";
            targetRow.hidden = true;
            sourceChange.disabled = false;
            targetChange.disabled = true;
            applyButton.textContent = "승인 후 수식 적용";
            applyButton.disabled = true;
            multiple = false;
        }
        function showPreview(instruction, selection, preview, target) {
            multiple = preview.plan.actions.length > 1;
            open();
            requestText.textContent = instruction;
            sourceAddress.textContent = selection.address;
            targetAddress.textContent = target.address;
            targetRow.hidden = false;
            previewText.textContent = preview.plan.actions.map(function (action, index) {
                return (index + 1) + ". " + action.output_label + "\n" +
                    "결과: " + action.target_range + "\n" +
                    "수식: " + action.formula;
            }).join("\n\n") + "\n" +
                "적용: " + target.row_count + "행\n" +
                "설명: " + preview.plan.summary;
            status.textContent = target.reason === "automatic"
                ? "기존 결과를 피해 오른쪽의 빈 열을 자동으로 제안했습니다."
                : target.reason === "manual"
                    ? "선택한 열을 결과 범위로 사용합니다."
                    : "빈 결과 범위를 확인했습니다. 수식을 검토한 뒤 승인하세요.";
            sourceChange.disabled = false;
            targetChange.disabled = multiple;
            applyButton.disabled = false;
        }
        return {
            open: open,
            reset: reset,
            showPreview: showPreview,
            setStatus: function (text) { open(); status.textContent = text; },
            setApplied: function (result) {
                applyButton.disabled = true;
                sourceChange.disabled = true;
                targetChange.disabled = true;
                applyButton.textContent = "적용 완료";
                status.textContent = result.address + " · " + result.row_count + "행에 수식을 적용했습니다.";
            },
            setBusy: function (busy, hasPreview, applied) {
                sourceChange.disabled = busy || applied;
                targetChange.disabled = busy || !hasPreview || applied || multiple;
                applyButton.disabled = busy || !hasPreview || applied;
            },
            bind: function (handlers) {
                sourceChange.addEventListener("click", handlers.source);
                targetChange.addEventListener("click", handlers.target);
                applyButton.addEventListener("click", handlers.apply);
            }
        };
    };
})();
