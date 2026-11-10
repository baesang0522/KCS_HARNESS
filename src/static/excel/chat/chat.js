"use strict";
(function () {
    window.createChatController = function (options) {
        var api = options.api;
        var message = document.getElementById('message');
        var notice = document.getElementById('notice');
        var conversation = document.getElementById('conversation');
        var welcome = document.getElementById('welcome-content');
        var scrollArea = document.querySelector('main');
        var composing = false;
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
            options.onBusy(value);
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
            options.closeTaskCards();
            options.resetTasks();
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

        async function sendMessage(advice) {
            if (sending) return false;

            var draft = advice ? message.value : null;
            var value = advice
                ? "추가 열과 열 설명도 참고해서 AI 정제 의견을 줘. 모델규격 정제는 대문자 기준 빈도 상위 100개 조합으로 분석해줘."
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
            options.closeTaskCards();
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
                    var context = await options.getWorkspace().context();
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
                    var data = await options.getWorkspace().readRecommendation(
                        reply.ui_action.column_ids,
                        pendingRequest.workspace,
                        function (label, done, total) {
                            if (!run.cancelled) notice.textContent = label + " · " + done + "/" + total + "행";
                        },
                        function () { checkChat(run); }
                    );
                    checkChat(run);
                    notice.textContent = "데이터를 분석하고 정제 의견을 준비하고 있습니다…";
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
                    await options.handleUIAction(reply.ui_action, value);
                    if (reply.ui_action && reply.ui_action.type === "configure_operation" && reply.ui_action.operation.kind === "extract") {
                        setBusy(false);
                        await options.getWorkspace().recommendExtraction();
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
                options.closeTaskCards();
                appendMessage('assistant', error.message);
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

        return {
            initialize: initializeConversation, sendMessage: sendMessage,
            appendMessage: appendMessage, enterConversation: enterConversation,
            beginRequest: beginRequest, endRequest: endRequest,
            checkRequest: checkChat, reportStop: reportStop,
            setBusy: setBusy, isBusy: function () { return sending; },
            getConversationId: function () { return conversationId; }
        };
    };
})();
