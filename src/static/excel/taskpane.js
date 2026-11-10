"use strict";
(function () {
    var api = window.apiClient;
    var workspace = null, formula = null, help = null;
    var connection = document.getElementById('connection');
    var diagnostic = document.getElementById('diagnostic');
    var ready = false;
    var build = (document.querySelector('meta[name="kcs-ui-version"]') || {}).content || "확인 필요";
    diagnostic.textContent = 'Office 초기화 대기 · ' + navigator.userAgent;
    if (typeof Office !== 'undefined') {
        Office.onReady(function (info) {
            ready = info.host === Office.HostType.Excel;
            connection.textContent = ready ? 'Excel 연결됨' : '브라우저 미리보기';
            if (ready) {
                connection.classList.add('connected');
            }
            diagnostic.textContent = '화면 버전: ' + build + '\nHost: ' + info.host + ' / Platform: ' + info.platform + '\n' + navigator.userAgent;
        });
    }
    window.setTimeout(function () {
        if (!ready) {
            connection.textContent = 'Excel 연결 미확인 · 화면 사용 가능';
            diagnostic.textContent += '\nExcel 안에서 이 상태가 지속되면 Office.js 경로·인증서·추가 기능 정책을 확인하세요.';
        }
    }, 8000);
    var chat = window.createChatController({
        api: api,
        getWorkspace: function () { return workspace; },
        closeTaskCards: closeTaskCards,
        resetTasks: function () { workspace.reset(); formula.reset(); },
        handleUIAction: handleUIAction,
        onBusy: function (value) {
            if (help) help.updateControls();
            if (workspace) workspace.setBusy(value);
            if (formula) formula.setBusy(value);
        }
    });
    function closeTaskCards() {
        if (help) help.dismiss();
        if (workspace) workspace.dismiss();
        if (formula) formula.dismiss();
    }
    function completeTask(text) {
        closeTaskCards();
        chat.enterConversation();
        chat.appendMessage('assistant', text);
    }
    async function handleUIAction(action, instruction) {
        closeTaskCards();
        if (!action) return;

        if (action.type === "open_cleaning_help") {
            await help.open(action.column_ids);
            return;
        }
        if (action.type === "configure_similarity") {
            await workspace.configureSimilarity(action.similarity);
            return;
        }
        if (action.type === "configure_operation") {
            await workspace.configure(action.operation);
            return;
        }
        if (action.type !== "confirm_selection") throw new Error("지원하지 않는 화면 요청입니다.");
        if (action.task_type === "formula") {
            formula.openAndSelect(instruction, {workspace_id: action.workspace_id, column_ids: action.column_ids});
        } else {
            await workspace.open(action.task_type);
        }
    }

    document.querySelectorAll('[data-prompt], [data-task]').forEach(function (button) {
        button.addEventListener('click', async function () {
            if (chat.isBusy()) return;
            var task = button.getAttribute('data-task');
            if (task) { closeTaskCards(); await workspace.open(task); return; }
            document.getElementById('message').value = button.getAttribute('data-prompt') || '';
            await chat.sendMessage();
        });
    });
    document.getElementById("open-workspace").addEventListener("click", async function () {
        if (!chat.isBusy()) { closeTaskCards(); await workspace.open(); }
    });
    document.querySelectorAll('[data-close-task]').forEach(function (button) {
        button.addEventListener('click', function () { if (!chat.isBusy()) closeTaskCards(); });
    });

    workspace = window.createWorkspaceController({
        api: api,
        enterConversation: chat.enterConversation,
        complete: completeTask,
        isBusy: chat.isBusy,
        setBusy: chat.setBusy,
        getConversationId: chat.getConversationId
    });
    formula = window.createFormulaController({
        ui: window.createFormulaUI({
            conversation: document.getElementById('conversation'),
            scrollArea: document.querySelector('main'),
            enterConversation: chat.enterConversation,
            appendMessage: chat.appendMessage
        }),
        api: api,
        excel: window.formulaSheet,
        beginRequest: chat.beginRequest,
        endRequest: chat.endRequest,
        checkRequest: chat.checkRequest,
        reportStop: chat.reportStop,
        getTarget: workspace.formulaTarget,
        prepareOutput: workspace.prepareFormulaOutput,
        validateSource: workspace.validateFormulaSource,
        getResultColumns: workspace.formulaResultColumns,
        onResult: workspace.formulaResult,
        complete: completeTask,
        isReady: function () { return ready; },
        isBusy: chat.isBusy,
        setBusy: chat.setBusy,
        getConversationId: chat.getConversationId
    });
    help = window.createCleaningHelp({
        workspace: workspace, isBusy: chat.isBusy, setBusy: chat.setBusy,
        closeTaskCards: closeTaskCards, enterConversation: chat.enterConversation,
        sendMessage: chat.sendMessage
    });
    chat.initialize();
})();
