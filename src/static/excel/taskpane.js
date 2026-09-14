"use strict";
// UI-only prototype: no workbook access or LLM requests.
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
}

var sending = false;
var conversationId = null;
var pendingRequest = null;
var storageKey = 'kcs-chat-session-v1';

function newRequestId() {
    // HTTP 개발 환경에서도 사용할 수 있는 UUID 생성
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);

    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;

    var hex = Array.from(bytes, function (value) {
        return value.toString(16).padStart(2, '0');
    }).join('');

    return hex.slice(0, 8) + '-' +
        hex.slice(8, 12) + '-' +
        hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' +
        hex.slice(20);
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
    document.querySelector('.send').disabled = value;
    document.getElementById('new-chat').disabled = value;
    message.readOnly = value;
}

async function requestJson(path, options) {
    var response = await fetch(path, options);
    var data = await response.json().catch(function () {
        return {};
    });

    if (!response.ok) {
        var detail = typeof data.detail === 'string'
            ? data.detail
            : '요청 실패: HTTP ' + response.status;

        var error = new Error(detail);
        error.status = response.status;
        throw error;
    }

    return data;
}

async function createConversation() {
    var data = await requestJson('/conversations', {
        method: 'POST'
    });

    conversationId = data.conversation_id;
    pendingRequest = null;
    saveSession();
}

function renderMessages(messages) {
    conversation.textContent = '';
    welcome.hidden = messages.length > 0;
    conversation.hidden = messages.length === 0;

    messages.forEach(function (item) {
        appendMessage(item.role, item.content);
    });
}

async function refreshConversation() {
    var data = await requestJson(
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

async function sendMessage() {
    if (sending) return;

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
    notice.textContent = '답변을 생성하고 있습니다…';

    try {
        if (!conversationId) {
            await createConversation();
        }

        if (!pendingRequest) {
            pendingRequest = {
                conversation_id: conversationId,
                request_id: newRequestId(),
                message: value
            };
            saveSession();
        }

        await requestJson('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingRequest)
        });

        pendingRequest = null;
        saveSession();
        message.value = '';

        try {
            await refreshConversation();
            notice.textContent = '';
        } catch (refreshError) {
            notice.textContent =
                '답변은 서버에 저장됐지만 화면을 갱신하지 못했습니다. ' +
                '같은 질문을 다시 보내지 말고 대화창을 다시 열어 주세요.';
        }

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

var suggestions = document.querySelectorAll('[data-prompt]');
var _loop_1 = function (i) {
    suggestions[i].addEventListener('click', function () {
        if (sending) return;

        message.value = suggestions[i].getAttribute('data-prompt') || '';
        message.focus();
    });
};
for (var i = 0; i < suggestions.length; i++) {
    _loop_1(i);
}
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

initializeConversation();
