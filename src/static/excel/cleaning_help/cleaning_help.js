"use strict";
(function () {
    window.createCleaningHelp = function (options) {
        var workspace = options.workspace;
        var helpContext = null;
        var helpPanel = document.getElementById("cleaning-help");
        var helpKind = document.getElementById("cleaning-help-kind");
        var helpPreferredId = null;
        var workPanel = document.getElementById("work-panel");
        var workHome = workPanel.parentNode;
        var workNext = workPanel.nextSibling;
        var notice = document.getElementById('notice');
        function restoreHelpWorkspace() {
            if (workPanel.parentNode !== workHome) {
                workHome.insertBefore(workPanel, workNext);
            }
        }

        function updateHelpControls() {
            helpKind.disabled = options.isBusy() || !helpContext;
            document.getElementById("cleaning-help-setup").disabled = options.isBusy();
            document.getElementById("cleaning-help-advice").disabled =
                options.isBusy() || !helpContext || helpKind.value !== "advice";
            var models = helpContext && helpContext.task_type === "model_normalization"
                ? helpContext.columns.filter(function (column) { return column.role === "model_spec"; }) : [];
            helpKind.querySelector('option[value="extract"]').disabled = models.length !== 1;
        }

        async function currentHelpContext() {
            var expected = helpContext;
            if (!expected) throw new Error(window.errorMessages.WORKSPACE_REQUIRED);
            var current = await workspace.context();
            if (!current || current.workspace_id !== expected.workspace_id ||
                current.worksheet_id !== expected.worksheet_id || current.table_id !== expected.table_id) {
                throw new Error("작업 표가 바뀌었습니다. 정제 도움을 다시 열어 주세요.");
            }
            return current;
        }

        async function showCleaningHelp(columnIds) {
            options.closeTaskCards();
            var context = await workspace.context();
            var preferred = columnIds || (context ? context.target_column_ids : []);
            helpPreferredId = preferred && preferred.length === 1 ? preferred[0] : null;
            if (helpPreferredId && (!context || !context.columns.some(function (column) {
                return column.column_id === helpPreferredId;
            }))) throw new Error("요청한 열이 없습니다. 정제 도움을 다시 열어 주세요.");
            helpContext = context;
            helpKind.value = "";
            helpPanel.dataset.mode = "";
            document.getElementById("cleaning-help-hint").hidden = false;
            document.getElementById("cleaning-help-advice-panel").hidden = true;
            document.getElementById("cleaning-help-setup").hidden = !!context;
            document.getElementById("cleaning-help-scope").textContent = context
                ? context.sheet_name + " · 도움 방식을 선택하세요."
                : "작업 시트를 먼저 준비한 뒤 작업 화면의 ‘정제 도움’을 누르세요.";
            options.enterConversation();
            helpPanel.hidden = false;
            updateHelpControls();
            document.getElementById("cleaning-help-title").focus();
        }

        async function chooseHelpMode() {
            if (options.isBusy()) return;
            var mode = helpKind.value;
            options.setBusy(true);
            workspace.dismiss();
            helpPanel.dataset.mode = mode;
            document.getElementById("cleaning-help-hint").hidden = !!mode;
            document.getElementById("cleaning-help-advice-panel").hidden = mode !== "advice";
            try {
                if (!mode) return;
                var current = await currentHelpContext();
                document.getElementById("cleaning-help-scope").textContent = current.sheet_name +
                    (mode === "advice" ? (current.task_type === "model_normalization"
                        ? " · 대문자 기준 빈도 상위 100개 조합" : " · 모든 데이터 열·설명·전체 행")
                        : " · 현재 대상 " + current.row_count.toLocaleString() + "행");
                if (mode === "advice") return;
                document.getElementById("cleaning-help-work").appendChild(workPanel);
                if (mode === "similarity") {
                    var id = current.columns.some(function (column) {
                        return column.column_id === helpPreferredId;
                    }) ? helpPreferredId : null;
                    await workspace.configureSimilarity({column_id: id, group_column_id: null});
                } else if (mode === "extract") {
                    var models = current.columns.filter(function (column) { return column.role === "model_spec"; });
                    if (current.task_type !== "model_normalization" || models.length !== 1) {
                        throw new Error("작업 준비에서 모델규격명 열을 지정하세요.");
                    }
                    await workspace.configure({kind: "extract", column_ids: [models[0].column_id],
                        extraction_mode: null, rules: [], delimiter: null, mappings: []});
                }
            } catch (error) {
                workPanel.hidden = true;
                notice.textContent = error.message;
            } finally {
                options.setBusy(false);
            }
        }

        document.querySelectorAll('[data-open-cleaning-help]').forEach(function (button) {
            button.addEventListener('click', async function () {
                if (options.isBusy()) return;
                options.setBusy(true);
                try { await showCleaningHelp(); }
                catch (error) { notice.textContent = error.message; }
                finally { options.setBusy(false); }
            });
        });
        helpKind.addEventListener('change', chooseHelpMode);
        document.getElementById("cleaning-help-setup").addEventListener('click', async function () {
            if (options.isBusy()) return;
            options.closeTaskCards();
            await workspace.open();
        });
        document.getElementById("cleaning-help-advice").addEventListener('click', async function () {
            if (options.isBusy() || helpKind.value !== "advice") return;
            options.setBusy(true);
            try {
                var current = await currentHelpContext();
                options.setBusy(false);
                await options.sendMessage({workspace_id: current.workspace_id});
            } catch (error) {
                notice.textContent = error.message;
            } finally {
                options.setBusy(false);
            }
        });

        return {
            open: showCleaningHelp,
            updateControls: updateHelpControls,
            dismiss: function () {
                restoreHelpWorkspace();
                helpPanel.hidden = true;
                helpContext = null;
            }
        };
    };
})();
