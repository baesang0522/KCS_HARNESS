"use strict";
(function () {
    window.createTaskMessages = function (chat) {
        var current = null, inputRequest = null, controls = new Set();
        function say(text) {
            chat.enterConversation();
            var message = chat.appendMessage("assistant", "");
            message.classList.add("task-message");
            message.querySelector('.message-body').textContent = text;
            return message;
        }
        function button(parent, label, callback) {
            var node = document.createElement('button'); node.type = 'button'; node.textContent = label;
            var live = true;
            function update(dispose) { if (dispose === true) live = false; node.disabled = !live || chat.isBusy(); }
            controls.add(update);
            node.addEventListener('click', async function () {
                if (!live || chat.isBusy()) return;
                try { await callback(); } catch (error) { say(error.message); }
            });
            parent.appendChild(node); update();
            return {disable: function () { live = false; update(); controls.delete(update); }, node: node};
        }
        function table(parent, headers, rows) {
            var details = document.createElement('details'), summary = document.createElement('summary');
            summary.textContent = '전체 결과 보기 · ' + rows.length.toLocaleString() + '행'; details.appendChild(summary);
            var body = document.createElement('div'), offset = 0, previous, next;
            function render() {
                body.replaceChildren();
                var grid = document.createElement('table'), head = document.createElement('tr');
                headers.forEach(function (text) { var th = document.createElement('th'); th.textContent = text; th.setAttribute('scope', 'col'); head.appendChild(th); });
                grid.appendChild(head);
                rows.slice(offset, offset + 10).forEach(function (values) {
                    var tr = document.createElement('tr');
                    values.forEach(function (value) { var td = document.createElement('td'); td.textContent = String(value == null ? '' : value); tr.appendChild(td); });
                    grid.appendChild(tr);
                });
                body.appendChild(grid);
                var label = document.createElement('p'); label.textContent = rows.length ? (offset + 1) + '–' + Math.min(offset + 10, rows.length) + ' / ' + rows.length : '결과 없음'; body.appendChild(label);
                previous.disabled = offset === 0; next.disabled = offset + 10 >= rows.length;
            }
            details.appendChild(body);
            previous = document.createElement('button'); next = document.createElement('button');
            previous.type = next.type = 'button'; previous.textContent = '이전'; next.textContent = '다음';
            previous.addEventListener('click', function () { offset = Math.max(0, offset - 10); render(); });
            next.addEventListener('click', function () { if (offset + 10 < rows.length) offset += 10; render(); });
            details.appendChild(previous); details.appendChild(next); parent.appendChild(details); render();
        }
        function confirm(text, handlers, headers, rows) {
            if (current) current.disable();
            inputRequest = null;
            var message = say(text), active = true, buttons = [];
            if (rows) table(message, headers, rows);
            var proposal = {
                disable: function () { active = false; buttons.forEach(function (b) { b.disable(); }); if (current === proposal) current = null; },
                run: async function (name) {
                    if (!active || chat.isBusy()) return false;
                    proposal.disable();
                    chat.appendMessage('user', name === 'apply' ? '적용' : '취소');
                    try { await handlers[name](); } catch (error) { say(error.message); }
                    return true;
                }
            };
            buttons.push(button(message, '적용', function () { return proposal.run('apply'); }));
            buttons.push(button(message, '취소', function () { return proposal.run('cancel'); }));
            current = proposal;
            return proposal;
        }
        return {say: say, table: table, button: button, confirm: confirm,
            busy: function () { controls.forEach(function (update) { update(); }); },
            reset: function () { if (current) current.disable(); inputRequest = null; controls.forEach(function (update) { update(true); }); controls.clear(); },
            ask: function (text, callback) { inputRequest = callback; say(text); },
            command: async function (text) {
                if (inputRequest) {
                    var callback = inputRequest; inputRequest = null;
                    chat.appendMessage('user', text);
                    if (/^취소[.!]?$/.test(text)) say('확인 기록을 취소했어.');
                    else await callback(text);
                    return true;
                }
                var action = /^(적용|적용해|적용해줘|적용해 줘|반영해줘|반영해 줘)[.!]?$/u.test(text) ? 'apply' : /^(취소|취소해|취소해줘|취소해 줘)[.!]?$/u.test(text) ? 'cancel' : null;
                if (!action) return false;
                if (current) await current.run(action);
                else say('적용 대기 중인 미리보기가 없어. 원하는 작업을 먼저 요청해 줘.');
                return true;
            }
        };
    };
})();
