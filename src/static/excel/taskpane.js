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
        connection.textContent = ready ? 'Excel 연결됨 · 모의 응답' : '브라우저 미리보기';
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
    label.textContent = role === 'user' ? '나' : '도우미 · 모의 응답';
    var body = document.createElement('p');
    body.textContent = text;
    bubble.appendChild(label);
    bubble.appendChild(body);
    conversation.appendChild(bubble);
    scrollArea.scrollTop = scrollArea.scrollHeight;
}
function sendMessage() {
    var value = message.value.trim();
    if (!value) {
        notice.textContent = '메시지를 입력해 주세요.';
        return;
    }
    notice.textContent = '';
    welcome.hidden = true;
    conversation.hidden = false;
    appendMessage('user', value);
    appendMessage('assistant', '메시지를 받았습니다. 지금은 대화창 동작을 확인하는 프로토타입입니다.\n실제 AI 답변과 엑셀 파일 읽기·수정은 아직 연결하지 않았습니다.');
    message.value = '';
    message.focus();
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
