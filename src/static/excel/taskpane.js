"use strict";

(function () {
    // 채팅 입력·대화 세션과 작업 화면을 연결한다.
    var api = window.apiClient;
    var normalization = null;
    var counterparty = null;
    var formula = null;
    var connection = document.getElementById('connection');
    var message = document.getElementById('message');
    var notice = document.getElementById('notice');
    var conversation = document.getElementById('conversation');
    var welcome = document.getElementById('welcome-content');
    var scrollArea = document.querySelector('main');
    var diagnostic = document.getElementById('diagnostic');
    var ready = false;
    var composing = false;
    diagnostic.textContent = 'Office 초기화 대기 · ' + navigator.userAgent;
    if (typeof Office !== 'undefined') {
        Office.onReady(function (info) {
            ready = info.host === Office.HostType.Excel;
            connection.textContent = ready ? 'Excel 연결됨' : '브라우저 미리보기';
            if (ready) {
                connection.classList.add('connected');
            }
            diagnostic.textContent = 'Host: ' + info.host + ' / Platform: ' + info.platform + '\n' + navigator.userAgent;
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
        var body = document.createElement('p');
        body.textContent = text;
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

    var pendingBubble = null;
    var sending = false;
    var conversationId = null;
    var pendingRequest = null;
    var storageKey = 'kcs-chat-session-v1';

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
        document.querySelector('.send').disabled = value;
        document.getElementById('new-chat').disabled = value;
        message.readOnly = value;
        document.getElementById('attach-range').disabled = value;
        document.querySelectorAll('[data-prompt]').forEach(function (button) {
            button.disabled = value;
        });
        if (normalization) normalization.setBusy(value);
        if (counterparty) counterparty.setBusy(value);
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
        normalization.reset();
        counterparty.reset();
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
                    '같은 내용으로 전송하면 기존 요청을 확인합니다.';
            }
        } catch (error) {
            notice.textContent = error.message;
        } finally {
            setBusy(false);
        }
    }

    async function handleUIAction(action, instruction) {
        if (!action) return;

        if (action.type !== "confirm_selection") {
            throw new Error("지원하지 않는 화면 요청입니다.");
        }

        if (action.task_type === "model_normalization") {
            normalization.open();
            return;
        }

        if (action.task_type === "counterparty_cleanup") {
            counterparty.openAndSelect();
            return;
        }

        if (action.task_type === "formula") {
            formula.openAndSelect(instruction);
            return;
        }

        // 다음 단계에서 작업별 공통 확인 화면으로 교체한다.
        var name = action.task_type === "counterparty_cleanup"
            ? "거래처 정리"
            : "수식 제안";

        notice.textContent =
            name + " 요청으로 확인했습니다. " +
            "이 작업의 범위 확인 화면은 다음 단계에서 연결합니다.";
    }

    async function sendMessage() {
        if (sending) return false;

        var value = message.value.trim();

        if (!value) {
            notice.textContent = '메시지를 입력해 주세요.';
            return;
        }

        // 응답을 못 받은 요청을 새 요청으로 조용히 바꾸지 않는다.
        if (pendingRequest && pendingRequest.message !== value) {
            notice.textContent =
                '미확인 요청을 먼저 같은 내용으로 다시 보내거나 ' +
                '새 대화를 시작해 주세요.';
            return;
        }

        setBusy(true);
        enterConversation();
        if (!pendingBubble) pendingBubble = appendMessage('user', value);
        message.value = '';
        notice.textContent = '답변을 생성하고 있습니다…';

        try {
            if (!conversationId) {
                await createConversation();
            }

            if (!pendingRequest) {
                pendingRequest = {
                    conversation_id: conversationId,
                    request_id: api.newRequestId(),
                    message: value
                };
                saveSession();
            }

            var reply = await api.requestJson('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingRequest)
            });

            pendingRequest = null;
            saveSession();
            message.value = '';

            pendingBubble = null;
            appendMessage('assistant', reply.answer);
            notice.textContent = '';

            try {
                await handleUIAction(reply.ui_action, value);
            } catch (uiError) {
                // 서버에서 성공한 요청을 다시 전송하게 만들지 않는다.
                notice.textContent =
                    "답변은 받았지만 작업 화면을 열지 못했습니다. " +
                    uiError.message;
            }

            return true;

        } catch (error) {
            notice.textContent = error.message;
            message.value = value;

        } finally {
            setBusy(false);
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

    document.querySelectorAll('[data-prompt]').forEach(function (button) {
        button.addEventListener('click', async function () {
            if (sending) return;
            message.value = button.getAttribute('data-prompt') || '';
            await sendMessage();
        });
    });
    document.getElementById('composer').addEventListener('submit', function (event) {
        event.preventDefault();
        sendMessage();
    });
    message.addEventListener('compositionstart', function () { composing = true; });
    message.addEventListener('compositionend', function () { composing = false; });
    message.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            sendMessage();
        }
    });

    normalization = window.createNormalizationController({
        ui: window.createNormalizationUI({
            conversation: conversation,
            scrollArea: scrollArea,
            enterConversation: enterConversation,
            appendMessage: appendMessage
        }),
        api: api,
        excel: window.excelBridge,
        isReady: function () { return ready; },
        isBusy: function () { return sending; },
        setBusy: setBusy,
        getConversationId: function () { return conversationId; }
    });
    counterparty = window.createCounterpartyController({
        ui: window.createCounterpartyUI({
            conversation: conversation,
            scrollArea: scrollArea,
            enterConversation: enterConversation,
            appendMessage: appendMessage
        }),
        api: api,
        excel: window.excelBridge,
        isReady: function () { return ready; },
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
        excel: window.excelBridge,
        isReady: function () { return ready; },
        isBusy: function () { return sending; },
        setBusy: setBusy,
        getConversationId: function () { return conversationId; }
    });
    initializeConversation();
})();
