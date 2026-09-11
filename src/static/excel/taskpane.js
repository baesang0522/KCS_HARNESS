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

async function sendMessage() {
    if (sending) return;

    var value = message.value.trim();
    if (!value) {
        notice.textContent = '메시지를 입력해 주세요.';
        return;
    }

    var sendButton = document.querySelector('.send');
    var newChatButton = document.getElementById('new-chat');

    sending = true;
    sendButton.disabled = true;
    newChatButton.disabled = true;
    message.readOnly = true;

    welcome.hidden = true;
    conversation.hidden = false;
    appendMessage('user', value);
    message.value = '';
    notice.textContent = '답변을 생성하고 있습니다…';

    try {
        // 화면을 제공한 하네스 서버의 /chat으로 요청합니다.
        var response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: value })
        });

        if (!response.ok) {
            throw new Error('하네스 요청 실패: HTTP ' + response.status);
        }

        var data = await response.json();

        if (typeof data.answer !== 'string' || !data.answer.trim()) {
            throw new Error('하네스에서 답변을 받지 못했습니다.');
        }

        appendMessage('assistant', data.answer);
        notice.textContent = '';
    } catch (error) {
        notice.textContent = error.message
            + ' 서버 로그와 LLM 연결을 확인하고 다시 전송해 주세요.';
        message.value = value;
    } finally {
        sending = false;
        sendButton.disabled = false;
        newChatButton.disabled = false;
        message.readOnly = false;
        message.focus();
    }
}

var suggestions = document.querySelectorAll('[data-prompt]');
var _loop_1 = function (i) {
    suggestions[i].addEventListener('click', function () {
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
document.getElementById('new-chat').addEventListener('click', function () {
    conversation.textContent = '';
    conversation.hidden = true;
    welcome.hidden = false;
    message.value = '';
    notice.textContent = '';
    message.focus();
});
