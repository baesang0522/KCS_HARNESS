"use strict";
(function () {
    var api = window.apiClient, workspace = null, formula = null, documents = null, investigation = null, reviewPreprocess = null;
    var agent = null, recovery = null, messages = null, ready = false;
    var connection = document.getElementById('connection');
    if (typeof Office !== 'undefined') Office.onReady(function (info) {
        ready = info.host === Office.HostType.Excel;
        connection.textContent = ready ? 'Excel 연결됨' : '브라우저 미리보기';
        if (ready) connection.classList.add('connected');
    });
    var chat = window.createChatController({
        api: api, getWorkspace: function () { return workspace; }, closeTaskCards: function () { if (workspace) workspace.dismiss(); },
        getReviewSheets: function () { return investigation ? investigation.reviewContext() : []; },
        resetTasks: function () { if (messages) messages.reset(); if (workspace) workspace.reset(); if (formula) formula.reset(); updateWorkspaceButton(); },
        handleUIAction: handleAction, runAgent: function (action, request) { return agent.run(action, request); },
        beforeManualAction: function () { if (agent) agent.detach(); },
        beforeAction: function (action) {
            if (action && !['document_action', 'open_investigation'].includes(action.type)) return investigation.ensureSynced();
        },
        localCommand: localCommand,
        canStopTask: function () { return workspace && workspace.isProcessing(); },
        stopTask: function () { if (workspace) workspace.cancelPending(); },
        onConversationChanged: async function (id) {
            if (reviewPreprocess) reviewPreprocess.reset();
            if (recovery) { recovery.reset(); await recovery.refresh(); }
            await Promise.all([documents && documents.load(id), investigation && investigation.load(id), agent && agent.load(id)]);
        },
        onBusy: function (value) {
            if (!value && agent) agent.flush();
            if (documents) documents.updateControls();
            if (workspace) workspace.setBusy(value);
            if (formula) formula.setBusy(value);
            if (messages) messages.busy();
            updateWorkspaceButton();
        }
    });
    messages = window.createTaskMessages(chat);
    function updateWorkspaceButton() {
        var hasWorkspace = workspace && workspace.referenceTarget(), button = document.getElementById('open-workspace');
        button.textContent = hasWorkspace ? '열 추가' : '작업 준비';
        button.title = hasWorkspace ? '원본 열을 현재 작업표에 추가' : '원본에서 작업표 만들기';
    }
    function completeTask(text, outcome) {
        if (agent && outcome) agent.complete(outcome, text);
        if (workspace) workspace.dismiss();
        messages.say(text);
        if (recovery && outcome) recovery.refresh();
    }
    async function newTask() {
        if (chat.isBusy()) return;
        chat.setBusy(true);
        try {
            if (agent) await agent.pause();
            await chat.newConversation();
            await workspace.open();
        } finally { chat.setBusy(false); }
    }
    document.getElementById('new-task').addEventListener('click', async function () {
        try { await newTask(); }
        catch (error) { document.getElementById('notice').textContent = error.message; }
    });
    async function localCommand(text) {
        if (await messages.command(text)) return true;
        if (/^(새 조사|새 조사 시작)[.!]?$/.test(text)) {
            await newTask(); return true;
        }
        if (/^(PDF\s*)?수정 내용 반영[.!]?$/i.test(text)) {
            messages.reset(); workspace.cancelPending(); formula.dismiss();
            chat.appendMessage('user', text); await investigation.previewApply(); return true;
        }
        if (/^최종 결과 기록[.!]?$/.test(text)) { chat.appendMessage('user', text); await workspace.recordFinal(); return true; }
        if (/^쓰기 결과 확인[.!]?$/.test(text)) { chat.appendMessage('user', text); await recovery.refresh(); return true; }
        return false;
    }
    async function handleAction(action, instruction, originRequestId) {
        if (!action) return;
        if (action.type === 'open_investigation') { await investigation.open(); return; }
        if (action.type === 'open_cleaning_help') { messages.say('정제할 열과 원하는 결과를 채팅으로 알려줘. 데이터에 맞는 방법을 찾으려면 AI 정제 의견을 요청해 줘.'); return; }
        if (action.type === 'open_group_review') throw new Error('묶음 검토는 보류 중이야. 작업 범위는 채팅으로 지정할 수 있어.');
        messages.reset();
        if (action.type === 'formula_output') { await formula.changeOutput(action); return; }
        workspace.cancelPending(); formula.dismiss();
        if (action.type === 'document_action') {
            if (action.action === 'preprocess') await reviewPreprocess.run(action);
            else if (action.action === 'apply') await investigation.previewApply([action.document_id]);
            else { var doc = documents.items().find(function (item) { return item.document_id === action.document_id; }); if (!doc) throw new Error('첨부한 PDF를 찾지 못했어.'); await investigation.extract(doc.document_id, doc.filename); }
            return;
        }
        if (action.type === 'workspace_action') { await workspace.assignRole(action); return; }
        if (action.type === 'change_scope') { completeTask(await workspace.changeScope(action.request, Object.assign({}, action, {origin_request_id: originRequestId}))); return; }
        if (action.type === 'configure_similarity') { await workspace.configureSimilarity(action.similarity); return; }
        if (action.type === 'configure_operation') {
            if (action.operation.kind === 'set' && !action.operation.condition) throw new Error('후보를 선택해 표시하는 기능은 보류 중이야. 조건 없는 전체 행 변경은 실행하지 않아.');
            chat.setBusy(true);
            try { await workspace.configure(action.operation, originRequestId); } finally { chat.setBusy(false); }
            if (action.operation.kind === 'extract' && !action.operation.extraction_mode) await workspace.recommendExtraction();
            else await workspace.previewOperation(action.auto_apply === true, action.auto_apply ? agent.verifyWrite : null);
            return;
        }
        if (action.type !== 'confirm_selection') throw new Error('지원하지 않는 작업 요청이야.');
        if (action.task_type === 'formula') formula.openAndSelect(action.instruction || instruction, {workspace_id: action.workspace_id, column_ids: action.column_ids, output: action.output, reference_sheet_names: action.reference_sheet_names || [], origin_request_id: originRequestId || null});
        else await workspace.open(action.task_type);
    }
    document.querySelectorAll('[data-task]').forEach(function (button) {
        button.addEventListener('click', async function () { if (!chat.isBusy()) { if (agent) await agent.pause(); await workspace.open(); } });
    });
    document.getElementById('open-workspace').addEventListener('click', async function () {
        if (chat.isBusy()) return;
        if (agent) await agent.pause();
        if (workspace.referenceTarget()) await workspace.openSourceColumns(); else await workspace.open();
    });
    document.querySelectorAll('[data-close-task]').forEach(function (button) { button.addEventListener('click', function () { if (!chat.isBusy()) workspace.dismiss(); }); });
    recovery = window.createWriteRecovery({messages: messages, api: api, getConversationId: chat.getConversationId,
        getWorkspace: function () { return workspace && workspace.referenceTarget(); }, isBusy: chat.isBusy, setBusy: chat.setBusy,
        onRecovered: function (receipt) { return workspace.recovered(receipt); }});
    workspace = window.createWorkspaceController({messages: messages, recovery: recovery, api: api,
        beforeApply: function () { return investigation.ensureSynced(); },
        getConditionVersions: function () { return investigation ? investigation.conditionVersions() : null; },
        enterConversation: chat.enterConversation, showWorkspace: function () { workspace.dismiss(); }, complete: completeTask,
        onJobCreated: function (kind, id) { return agent && agent.bind(kind, id); }, isBusy: chat.isBusy, setBusy: chat.setBusy,
        getConversationId: chat.getConversationId, newInvestigation: chat.newConversation,
        beforeWorkspaceChange: function (target) { if (investigation) investigation.validateWorkspace(target); },
        onWorkspaceReady: async function (target) { updateWorkspaceButton(); if (investigation) await investigation.bind(target); if (recovery) await recovery.refresh(); }
    });
    formula = window.createFormulaController({recovery: recovery, recoveryWorkspace: workspace.recoveryWorkspace,
        ui: window.createFormulaUI(messages), api: api, excel: window.formulaSheet,
        beginRequest: chat.beginRequest, endRequest: chat.endRequest, checkRequest: chat.checkRequest, reportStop: chat.reportStop,
        getTarget: workspace.formulaTarget, prepareOutput: workspace.prepareFormulaOutput, validateSource: workspace.validateFormulaSource,
        getResultColumns: workspace.formulaResultColumns, onResult: workspace.formulaResult, resolveOutput: workspace.resolveFormulaOutput,
        complete: completeTask, onJobCreated: function (kind, id) { return agent && agent.bind(kind, id); },
        isReady: function () { return ready; }, isBusy: chat.isBusy, setBusy: chat.setBusy, getConversationId: chat.getConversationId
    });
    investigation = window.createInvestigationController({messages: messages, api: api, getWorkspace: workspace.referenceTarget,
        onChanged: function () { if (documents) documents.render(); }, isBusy: chat.isBusy, setBusy: chat.setBusy,
        beginRequest: chat.beginRequest, endRequest: chat.endRequest, checkRequest: chat.checkRequest, reportStop: chat.reportStop});
    reviewPreprocess = window.createReviewPreprocess({messages: messages, api: api, getConversationId: chat.getConversationId, isBusy: chat.isBusy, setBusy: chat.setBusy});
    documents = window.createDocumentsController({applyReview: function () { if (agent) agent.detach(); return localCommand('PDF 수정 내용 반영'); }, readConditions: investigation.extract, beforeUpload: investigation.prepare, reviewInfo: investigation.info,
        api: api, getWorkspace: workspace.referenceTarget, isBusy: chat.isBusy, setBusy: chat.setBusy,
        beginRequest: chat.beginRequest, endRequest: chat.endRequest, checkRequest: chat.checkRequest, reportStop: chat.reportStop});
    agent = window.createAgentController({api: api, chat: chat, getWorkspace: function () { return workspace; }, beforeRead: investigation.ensureSynced, handleUIAction: handleAction});
    chat.initialize();
})();
