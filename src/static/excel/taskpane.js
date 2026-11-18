"use strict";
(function () {
    var api = window.apiClient;
    var workspace = null, formula = null, help = null, documents = null, investigation = null, reviewPreprocess = null;
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
        resetTasks: function () { workspace.reset(); formula.reset(); updateWorkspaceButton(); },
        handleUIAction: handleUIAction,
        beforeSend: function () { return investigation && investigation.ensureSynced(); },
        onConversationChanged: async function (id) {
            if (reviewPreprocess) reviewPreprocess.reset();
            await Promise.all([documents && documents.load(id), investigation && investigation.load(id)]);
        },
        onBusy: function (value) {
            if (documents) documents.updateControls();
            if (reviewPreprocess) reviewPreprocess.updateControls();
            if (help) help.updateControls();
            if (workspace) workspace.setBusy(value);
            if (formula) formula.setBusy(value);
            updateWorkspaceButton();
        }
    });
    function updateWorkspaceButton() {
        var hasWorkspace = workspace && workspace.referenceTarget();
        var button = document.getElementById("open-workspace");
        document.getElementById("open-scope").hidden = !hasWorkspace;
        button.textContent = hasWorkspace ? "열 추가" : "작업 준비";
        button.title = hasWorkspace ? "원본 열을 현재 작업표에 추가" : "작업표 만들기 또는 저장된 작업 이어가기";
    }
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

        if (action.type === "open_investigation") { await investigation.open(); return; }
        if (action.type === "open_cleaning_help") {
            await help.open(action.column_ids);
            return;
        }
        if (action.type === "open_group_review") {
            // 묶음 검토 보류: 저장된 예전 응답도 다시 열거나 셀을 쓰지 않는다.
            // await workspace.openGroups(action.column_ids && action.column_ids[0], action.request);
            throw new Error("묶음 검토는 현재 사용하지 않습니다. 작업 범위는 상단 ‘작업 범위’에서 지정하세요.");
        }
        if (action.type === "configure_similarity") {
            await workspace.configureSimilarity(action.similarity);
            return;
        }
        if (action.type === "configure_operation") {
            if (action.operation.kind === "set" && !action.operation.condition) {
                // await workspace.openGroups(action.operation.column_ids[0], {assigned_value: action.operation.assigned_value});
                throw new Error("후보를 선택해 표시하는 기능은 보류 중입니다. 조건을 생략한 전체 행 변경은 실행하지 않습니다.");
            }
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
        if (chat.isBusy()) return;
        if (workspace.referenceTarget()) await workspace.openSourceColumns();
        else { closeTaskCards(); await workspace.open(); }
    });
    document.getElementById("open-scope").addEventListener("click", async function () {
        if (!chat.isBusy() && workspace.referenceTarget()) await workspace.openScope();
    });
    document.querySelectorAll('[data-close-task]').forEach(function (button) {
        button.addEventListener('click', function () { if (!chat.isBusy()) closeTaskCards(); });
    });

    workspace = window.createWorkspaceController({
        api: api,
        enterConversation: chat.enterConversation,
        showWorkspace: closeTaskCards,
        complete: completeTask,
        isBusy: chat.isBusy,
        setBusy: chat.setBusy,
        getConversationId: chat.getConversationId,
        beforeWorkspaceChange: function (target) { if (investigation) investigation.validateWorkspace(target); },
        onWorkspaceReady: async function (target) {
            updateWorkspaceButton();
            if (investigation) await investigation.bind(target);
        }
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
    investigation = window.createInvestigationController({
        api: api, getWorkspace: workspace.referenceTarget,
        onChanged: function () { if (documents) documents.render(); },
        isBusy: chat.isBusy, setBusy: chat.setBusy,
        beginRequest: chat.beginRequest, endRequest: chat.endRequest,
        checkRequest: chat.checkRequest, reportStop: chat.reportStop
    });
    reviewPreprocess = window.createReviewPreprocess({
        api: api, getConversationId: chat.getConversationId, isBusy: chat.isBusy, setBusy: chat.setBusy,
        closeTaskCards: closeTaskCards
    });
    documents = window.createDocumentsController({
        readConditions: investigation.extract, preprocessReview: reviewPreprocess.open,
        beforeUpload: investigation.prepare, reviewInfo: investigation.info, applyReview: investigation.apply,
        api: api, getWorkspace: workspace.referenceTarget,
        isBusy: chat.isBusy, setBusy: chat.setBusy,
        beginRequest: chat.beginRequest, endRequest: chat.endRequest,
        checkRequest: chat.checkRequest, reportStop: chat.reportStop
    });
    chat.initialize();
})();
