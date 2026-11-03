"use strict";

(function () {
    // 채팅 입력·대화 세션과 작업 화면을 연결한다.
    var api = window.apiClient;
    var workspace = null;
    var formula = null;
    var helpContext = null;
    var helpPanel = document.getElementById("cleaning-help");
    var helpSimilarityColumn = document.getElementById("cleaning-help-similarity-column");
    var helpGroup = document.getElementById("cleaning-help-group");
    var helpExtractColumn = document.getElementById("cleaning-help-extract-column");
    var connection = document.getElementById('connection');
    var message = document.getElementById('message');
    var notice = document.getElementById('notice');
    var conversation = document.getElementById('conversation');
    var welcome = document.getElementById('welcome-content');
    var scrollArea = document.querySelector('main');
    var diagnostic = document.getElementById('diagnostic');
    var ready = false;
    var composing = false;
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
    function appendMessage(role, text) {
        var bubble = document.createElement('article');
        bubble.className = 'chat-message ' + role;
        var label = document.createElement('strong');
        label.textContent = role === 'user' ? '나' : '도우미';
        var body = document.createElement('div');
        body.className = 'message-body';

        if (role === 'assistant') {
            try { window.markdownRenderer.render(body, text); }
            catch (_) { body.textContent = text; }
        } else {
            body.textContent = text;
        }
        bubble.appendChild(label);
        bubble.appendChild(body);
        conversation.appendChild(bubble);
        scrollArea.scrollTop = scrollArea.scrollHeight;
        return bubble;
    }

    function enterConversation() {
        welcome.hidden = true;
        conversation.hidden = false;
    }

    function closeTaskCards() {
        helpPanel.hidden = true;
        helpContext = null;
        if (workspace) workspace.dismiss();
        if (formula) formula.dismiss();
    }

    function completeTask(text) {
        closeTaskCards();
        enterConversation();
        appendMessage('assistant', text);
    }

    var pendingBubble = null;
    var sending = false;
    var conversationId = null;
    var pendingRequest = null;
    var storageKey = 'kcs-chat-session-v1';
    var activeRequest = null;

    function beginRequest() {
        var run = {
            controller: new AbortController(), cancelled: false,
            request: null, stopping: Promise.resolve("")
        };
        activeRequest = run;
        return run;
    }

    function endRequest(run) {
        if (activeRequest === run) activeRequest = null;
    }

    async function reportStop(run) {
        notice.textContent = await run.stopping;
    }

    function checkChat(run) {
        if (run.cancelled) throw new DOMException("요청을 중지했습니다.", "AbortError");
    }

    async function cancelServerRequest(request) {
        if (!request) return "";
        var controller = new AbortController();
        var timer = window.setTimeout(function () { controller.abort(); }, 5000);
        try {
            await api.requestJson(
                '/conversations/' + encodeURIComponent(request.conversation_id) +
                '/requests/' + encodeURIComponent(request.request_id) + '/cancel',
                {method: 'POST', signal: controller.signal}
            );
            return "";
        } catch (error) {
            return "화면의 요청은 중지했지만 서버 중지는 확인하지 못했습니다. " + error.message;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function stopMessage() {
        var run = activeRequest;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        run.controller.abort();
        run.stopping = cancelServerRequest(run.request);
        notice.textContent = '요청을 중지하고 있습니다…';
        setBusy(true);
    }


    function saveSession() {
        try {
            localStorage.setItem(storageKey, JSON.stringify({
                conversation_id: conversationId,
                pending_request: pendingRequest
            }));
        } catch (_) {
            // 저장이 제한된 환경에서도 현재 창의 채팅은 계속 사용한다.
        }
    }

    function setBusy(value) {
        sending = value;
        var button = document.querySelector('.send');
        var stoppable = value && activeRequest;
        button.disabled = value && (!stoppable || activeRequest.cancelled);
        button.setAttribute('aria-label', stoppable ? '요청 중지' : '요청 보내기');
        button.title = stoppable ? '요청 중지' : '요청 보내기';
        button.querySelector('path').setAttribute('d', stoppable
            ? 'M7 7h10v10H7Z' : 'm6 12 6-6 6 6M12 6v13');
        document.getElementById('new-chat').disabled = value;
        document.getElementById('open-workspace').disabled = value;
        document.querySelectorAll('[data-close-task]').forEach(function (button) { button.disabled = value; });
        message.readOnly = value;
        document.querySelectorAll('[data-prompt], [data-task]').forEach(function (button) {
            button.disabled = value;
        });
        document.querySelectorAll('[data-open-cleaning-help]').forEach(function (button) {
            button.disabled = value;
        });
        updateHelpControls();
        if (workspace) workspace.setBusy(value);
        if (formula) formula.setBusy(value);
    }

    async function createConversation() {
        var data = await api.requestJson('/conversations', {
            method: 'POST'
        });

        conversationId = data.conversation_id;
        pendingRequest = null;
        saveSession();
    }

    function renderMessages(messages) {
        closeTaskCards();
        workspace.reset();
        formula.reset();
        pendingBubble = null;
        conversation.textContent = '';
        welcome.hidden = messages.length > 0;
        conversation.hidden = messages.length === 0;

        messages.forEach(function (item) {
            appendMessage(item.role, item.content);
        });
    }

    async function refreshConversation() {
        var data = await api.requestJson(
            '/conversations/' + encodeURIComponent(conversationId)
        );

        renderMessages(data.messages);
    }

    async function initializeConversation() {
        setBusy(true);

        try {
            try {
                var saved = JSON.parse(
                    localStorage.getItem(storageKey) || 'null'
                );

                if (saved && typeof saved.conversation_id === 'string') {
                    conversationId = saved.conversation_id;
                    pendingRequest = saved.pending_request || null;
                }
            } catch (_) {
                conversationId = null;
                pendingRequest = null;
            }

            if (conversationId) {
                try {
                    await refreshConversation();
                } catch (error) {
                    if (error.status !== 404) throw error;

                    // 메모리 저장소이므로 서버가 재시작되면 이전 대화가 사라진다.
                    await createConversation();
                    renderMessages([]);
                    notice.textContent =
                        '이전 대화가 없어 새 대화를 시작했습니다.';
                }
            } else {
                await createConversation();
                renderMessages([]);
            }

            if (pendingRequest) {
                message.value = pendingRequest.message;
                notice.textContent =
                    '완료 여부를 확인하지 못한 요청이 있습니다. ' +
                    '같은 내용으로 다시 보내거나 다른 질문을 입력할 수 있습니다.';
            }
        } catch (error) {
            notice.textContent = error.message;
        } finally {
            setBusy(false);
        }
    }

    function updateHelpControls() {
        helpSimilarityColumn.disabled = helpGroup.disabled = sending || !helpContext;
        helpExtractColumn.disabled = true;
        document.getElementById("cleaning-help-setup").disabled = sending;
        var sameColumn = helpGroup.value && helpGroup.value === helpSimilarityColumn.value;
        document.getElementById("cleaning-help-similarity-status").textContent = sameColumn
            ? "기준열과 계산 대상열은 서로 다르게 선택하세요." : "";
        document.querySelectorAll('[data-cleaning-help]').forEach(function (button) {
            var kind = button.getAttribute("data-cleaning-help");
            button.disabled = sending || !helpContext ||
                (kind === "similarity" && (!helpSimilarityColumn.value || !!sameColumn)) ||
                (kind === "extract" && !helpExtractColumn.value);
        });
    }

    function fillHelpColumns(select, columns, emptyLabel, preferred) {
        select.textContent = "";
        var placeholder = document.createElement("option");
        placeholder.value = ""; placeholder.textContent = emptyLabel;
        select.appendChild(placeholder);
        columns.forEach(function (column, index) {
            var option = document.createElement("option");
            option.value = column.column_id;
            option.textContent = (index + 1) + ". " + column.header;
            select.appendChild(option);
        });
        select.value = preferred || "";
    }

    async function showCleaningHelp(columnIds) {
        closeTaskCards();
        var context = await workspace.context();
        var columns = context ? context.columns : [];
        var preferred = columnIds || (context ? context.target_column_ids : []);
        var selected = preferred && preferred.length === 1 ? preferred[0] : "";
        if (selected && !columns.some(function (column) { return column.column_id === selected; })) {
            throw new Error("요청한 열이 없어졌습니다. 정제 도움을 다시 열어 주세요.");
        }
        fillHelpColumns(helpSimilarityColumn, columns, "계산 대상열을 선택하세요", selected);
        fillHelpColumns(helpGroup, columns, "제한 없음 · 대상 범위 전체에서 비교", "");
        var models = context && context.task_type === "model_normalization"
            ? columns.filter(function (column) { return column.role === "model_spec"; }) : [];
        if (models.length !== 1) models = [];
        fillHelpColumns(helpExtractColumn, models, "지정된 모델규격명 열 없음", models.length ? models[0].column_id : "");
        document.getElementById("cleaning-help-extract-scope").textContent = models.length
            ? "작업 준비에서 모델규격명으로 지정한 열만 사용합니다."
            : "모델규격 정제 작업에서 모델규격명 열을 지정해야 사용할 수 있습니다.";
        helpContext = context;
        document.getElementById("cleaning-help-setup").hidden = !!context;
        document.getElementById("cleaning-help-scope").textContent = context
            ? context.sheet_name + " · 유사도·추출: 현재 대상 " + context.row_count.toLocaleString() +
              "행 / AI 의견: 작업 표의 모든 데이터 열·설명·전체 행"
            : "작업 시트를 먼저 준비하세요. 준비 후 작업 화면의 ‘정제 도움’을 누르면 됩니다.";
        enterConversation();
        helpPanel.hidden = false;
        updateHelpControls();
        document.getElementById("cleaning-help-title").focus();
    }

    async function currentHelpSelection(kind) {
        var expected = helpContext;
        if (!expected) throw new Error("먼저 작업 시트를 준비하세요.");
        var current = await workspace.context();
        if (!current || current.workspace_id !== expected.workspace_id ||
            current.worksheet_id !== expected.worksheet_id || current.table_id !== expected.table_id) {
            throw new Error("작업 표가 바뀌었습니다. 정제 도움을 다시 열어 주세요.");
        }
        if (kind === "advice") return {workspace_id: current.workspace_id};
        var id = kind === "extract" ? helpExtractColumn.value : helpSimilarityColumn.value;
        var column = current.columns.find(function (item) { return item.column_id === id; });
        if (!column) throw new Error("대상 열이 없습니다. 정제 도움을 다시 열어 주세요.");
        var groupId = kind === "similarity" ? helpGroup.value : "";
        if (groupId && (groupId === id || !current.columns.some(function (item) { return item.column_id === groupId; }))) {
            throw new Error("유사도 기준열을 확인하고 정제 도움을 다시 열어 주세요.");
        }
        if (kind === "extract") {
            var models = current.columns.filter(function (item) { return item.role === "model_spec"; });
            if (current.task_type !== "model_normalization" || models.length !== 1 || models[0].column_id !== id) {
                throw new Error("모델규격명 대상이 바뀌었습니다. 정제 도움을 다시 열어 주세요.");
            }
        }
        return {column: column, group_column_id: groupId || null, workspace_id: current.workspace_id};
    }

    document.querySelectorAll('[data-open-cleaning-help]').forEach(function (button) {
        button.addEventListener('click', async function () {
            if (sending) return;
            setBusy(true);
            try { await showCleaningHelp(); }
            catch (error) { notice.textContent = error.message; }
            finally { setBusy(false); }
        });
    });
    helpSimilarityColumn.addEventListener('change', updateHelpControls);
    helpGroup.addEventListener('change', updateHelpControls);
    document.getElementById("cleaning-help-setup").addEventListener('click', async function () {
        if (sending) return;
        closeTaskCards();
        await workspace.open();
    });
    document.querySelectorAll('[data-cleaning-help]').forEach(function (button) {
        button.addEventListener('click', async function () {
            if (sending) return;
            setBusy(true);
            try {
                var kind = button.getAttribute('data-cleaning-help');
                var selection = await currentHelpSelection(kind);
                if (kind === "advice") {
                    setBusy(false);
                    await sendMessage(selection);
                } else {
                    closeTaskCards();
                    if (kind === "similarity") {
                        await workspace.configureSimilarity({column_id: selection.column.column_id, group_column_id: selection.group_column_id});
                    } else if (kind === "extract") {
                        await workspace.configure({kind: "extract", column_ids: [selection.column.column_id], extraction_mode: null, rules: [], delimiter: null, mappings: []});
                        setBusy(false);
                        await workspace.recommendExtraction();
                    }
                }
            } catch (error) { notice.textContent = error.message; }
            finally { setBusy(false); }
        });
    });

    async function handleUIAction(action, instruction) {
        closeTaskCards();
        if (!action) return;

        if (action.type === "open_cleaning_help") {
            await showCleaningHelp(action.column_ids);
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
            formula.openAndSelect(instruction);
        } else {
            await workspace.open(action.task_type);
        }
    }

    async function sendMessage(advice) {
        if (sending) return false;

        var draft = advice ? message.value : null;
        var value = advice
            ? "추가 열을 포함한 작업 표의 모든 데이터 열과 열 설명, 전체 행을 함께 보고 AI 정제 의견을 줘."
            : message.value.trim();

        if (!value) {
            notice.textContent = '메시지를 입력해 주세요.';
            return;
        }

        // 같은 질문은 기존 ID로 재시도하고, 다른 질문은 새 ID로 진행한다.
        if (pendingRequest && (pendingRequest.message !== value ||
            (advice && !pendingRequest.advice_requested))) {
            pendingRequest = null;
            pendingBubble = null;
            saveSession();
        }

        var run = beginRequest();
        setBusy(true);
        enterConversation();
        closeTaskCards();
        if (!pendingBubble) pendingBubble = appendMessage('user', value);
        message.value = '';
        notice.textContent = '답변을 생성하고 있습니다…';

        try {
            if (!conversationId) {
                await createConversation();
            }

            checkChat(run);
            if (!pendingRequest) {
                run.request = {
                    conversation_id: conversationId,
                    request_id: api.newRequestId()
                };
                var context = await workspace.context();
                checkChat(run);
                if (advice && (!context || context.workspace_id !== advice.workspace_id)) {
                    throw new Error("분석 대상이 바뀌었습니다. 정제 도움을 다시 열어 주세요.");
                }
                pendingRequest = Object.assign({}, run.request, {
                    advice_requested: !!advice,
                    message: value, workspace: context
                });
                saveSession();
            } else {
                run.request = pendingRequest;
            }

            var reply = await api.requestJson('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingRequest),
                signal: run.controller.signal
            });
            checkChat(run);

            if (reply.ui_action && reply.ui_action.type === "analyze_data") {
                notice.textContent = "전체 데이터를 읽고 있습니다…";
                var data = await workspace.readRecommendation(
                    reply.ui_action.column_ids,
                    pendingRequest.workspace,
                    function (label, done, total) {
                        if (!run.cancelled) notice.textContent = label + " · " + done + "/" + total + "행";
                    },
                    function () { checkChat(run); }
                );
                checkChat(run);
                notice.textContent = "전체 원문과 열 설명을 검토하고 있습니다. 데이터가 많으면 시간이 걸립니다.";
                reply = await api.requestJson('/chat/recommendation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({}, data, {
                        conversation_id: pendingRequest.conversation_id,
                        request_id: pendingRequest.request_id
                    })),
                    signal: run.controller.signal
                });
                checkChat(run);
            }

            checkChat(run);
            activeRequest = null;
            setBusy(true);
            pendingRequest = null;
            saveSession();
            message.value = '';

            pendingBubble = null;
            appendMessage('assistant', reply.answer);
            notice.textContent = '';

            try {
                await handleUIAction(reply.ui_action, value);
                if (reply.ui_action && reply.ui_action.type === "configure_operation" && reply.ui_action.operation.kind === "extract") {
                    setBusy(false);
                    await workspace.recommendExtraction();
                }
            } catch (uiError) {
                // 서버에서 성공한 요청을 다시 전송하게 만들지 않는다.
                notice.textContent =
                    "답변은 받았지만 작업 화면을 열지 못했습니다. " +
                    uiError.message;
            }

            return true;

        } catch (error) {
            if (run.cancelled) {
                pendingRequest = null;
                pendingBubble = null;
                saveSession();
                appendMessage('assistant', '요청을 중지했습니다.');
                message.value = value;
                await reportStop(run);
                return false;
            }
            // 422는 모델 실행 전 입력 검증 실패. 오래된 작업 문맥으로 재시도하지 않는다.
            if (error.status === 422) { pendingRequest = null; pendingBubble = null; saveSession(); }
            if (!pendingRequest) pendingBubble = null;
            closeTaskCards();
            appendMessage('assistant', '요청을 완료하지 못했습니다.\n\n' + error.message);
            notice.textContent = '같은 내용으로 다시 보내거나 다른 질문을 입력할 수 있습니다.';
            message.value = value;

        } finally {
            endRequest(run);
            setBusy(false);
            if (draft !== null) message.value = draft;
            message.focus();
        }
    }

    document.getElementById('new-chat').addEventListener(
        'click',
        async function () {
            if (sending) return;

            setBusy(true);

            try {
                await createConversation();
                renderMessages([]);
                message.value = '';
                notice.textContent = '';
            } catch (error) {
                notice.textContent = error.message;
            } finally {
                setBusy(false);
                message.focus();
            }
        }
    );

    document.querySelectorAll('[data-prompt], [data-task]').forEach(function (button) {
        button.addEventListener('click', async function () {
            if (sending) return;
            var task = button.getAttribute('data-task');
            if (task) { closeTaskCards(); await workspace.open(task); return; }
            message.value = button.getAttribute('data-prompt') || '';
            await sendMessage();
        });
    });
    document.getElementById('composer').addEventListener('submit', function (event) {
        event.preventDefault();
        if (activeRequest) stopMessage();
        else sendMessage();
    });
    document.getElementById('message-resize').addEventListener('click', function () {
        var expanded = this.getAttribute('aria-expanded') !== 'true';
        document.getElementById('composer-fields').hidden = !expanded;
        this.setAttribute('aria-expanded', String(expanded));
        this.textContent = expanded ? '입력칸 접기' : '입력칸 펼치기';
        if (expanded) message.focus();
    });
    message.addEventListener('compositionstart', function () { composing = true; });
    message.addEventListener('compositionend', function () { composing = false; });
    message.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            sendMessage();
        }
    });

    document.getElementById("open-workspace").addEventListener("click", async function () {
        if (!sending) { closeTaskCards(); await workspace.open(); }
    });
    document.querySelectorAll('[data-close-task]').forEach(function (button) {
        button.addEventListener('click', function () { if (!sending) closeTaskCards(); });
    });

    workspace = window.createWorkspaceController({
        api: api,
        enterConversation: enterConversation,
        complete: completeTask,
        isBusy: function () { return sending; },
        setBusy: setBusy,
        getConversationId: function () { return conversationId; }
    });
    formula = window.createFormulaController({
        ui: window.createFormulaUI({
            conversation: conversation,
            scrollArea: scrollArea,
            enterConversation: enterConversation,
            appendMessage: appendMessage
        }),
        api: api,
        excel: window.formulaSheet,
        beginRequest: beginRequest,
        endRequest: endRequest,
        checkRequest: checkChat,
        reportStop: reportStop,
        getTarget: workspace.formulaTarget,
        prepareOutput: workspace.prepareFormulaOutput,
        onResult: workspace.formulaResult,
        complete: completeTask,
        isReady: function () { return ready; },
        isBusy: function () { return sending; },
        setBusy: setBusy,
        getConversationId: function () { return conversationId; }
    });
    initializeConversation();
})();
