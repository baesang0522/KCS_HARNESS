"use strict";
(function () {
    window.createDocumentsController = function (options) {
        var api = options.api, cid = null, items = [], previewId = null, pageNumber = 1;
        var loadVersion = 0, pageVersion = 0;
        var panel = document.getElementById('documents-panel');
        var list = document.getElementById('documents-list');
        var status = document.getElementById('documents-status');
        var fileInput = document.getElementById('document-file');
        var picker = document.getElementById('document-add');
        var toggle = document.getElementById('documents-toggle');
        var viewer = document.getElementById('document-preview');
        var pageInput = document.getElementById('document-page');
        var pageBody = document.getElementById('document-page-body');
        var tasks = {investigation: '통합 조사', model_normalization: '모델규격 정제', counterparty_cleanup: '해외거래처부호 정제'};

        function base() { return '/conversations/' + encodeURIComponent(cid) + '/documents'; }
        function endpoint(id) { return base() + '/' + encodeURIComponent(id); }
        function node(tag, text) {
            var element = document.createElement(tag);
            if (text !== undefined) element.textContent = text;
            return element;
        }
        function openPanel() {
            panel.hidden = false;
            document.getElementById('documents-title').focus();
        }
        function currentWorkspace() { return options.getWorkspace(); }
        function updateControls() {
            var busy = options.isBusy();
            picker.disabled = busy || !cid;
            list.querySelectorAll('button, select').forEach(function (element) { element.disabled = busy; });
            viewer.querySelectorAll('button, input').forEach(function (element) { element.disabled = busy; });
        }
        function updateItem(item) {
            var index = items.findIndex(function (value) { return value.document_id === item.document_id; });
            if (index >= 0) items[index] = item;
            else items.push(item);
        }
        function render() {
            list.replaceChildren();
            toggle.textContent = '참고자료 (' + items.length + ')';
            items.forEach(function (item) {
                var row = node('article'); row.className = 'document-item';
                row.appendChild(node('strong', item.filename));
                var summary = item.page_count + '쪽 · 읽기 완료';
                if (item.unreadable_pages.length) summary += ' · 텍스트 없음: ' + item.unreadable_pages.join(', ') + '쪽';
                row.appendChild(node('p', summary));
                var label = node('label', '사용할 작업');
                var select = node('select');
                select.setAttribute('aria-label', item.filename + ' 사용할 작업');
                var empty = node('option', '선택하세요'); empty.value = ''; select.appendChild(empty);
                Object.keys(tasks).forEach(function (key) {
                    var choice = node('option', tasks[key]); choice.value = key; select.appendChild(choice);
                });
                var current = currentWorkspace();
                select.value = item.link ? item.link.task_type : current ? current.task_type : '';
                label.appendChild(select); row.appendChild(label);
                var linked = item.link && item.link.workspace;
                row.appendChild(node('p', linked ? '연결: ' + linked.sheet_name + ' · ' + tasks[item.link.task_type]
                    : item.link ? tasks[item.link.task_type] + ' 작업표 준비 대기' : '작업을 선택하고 연결하세요.'));
                var actions = node('div'); actions.className = 'document-actions';
                var link = node('button', '연결'); link.type = 'button';
                link.addEventListener('click', function () { return connect(item.document_id, select.value); });
                var read = node('button', '추출 내용 보기'); read.type = 'button';
                read.addEventListener('click', function () { return showPage(item.document_id, 1); });
                var remove = node('button', '제거'); remove.type = 'button';
                remove.setAttribute('aria-label', item.filename + ' 제거');
                remove.addEventListener('click', function () { return removeDocument(item.document_id); });
                actions.appendChild(link); actions.appendChild(read); actions.appendChild(remove);
                row.appendChild(actions); list.appendChild(row);
            });
            updateControls();
        }
        async function load(conversationId) {
            var version = ++loadVersion;
            cid = conversationId; items = []; previewId = null; ++pageVersion;
            viewer.hidden = true; panel.hidden = true; status.textContent = ''; render();
            try {
                var result = await api.requestJson(base());
                if (version !== loadVersion) return;
                items = result.documents; render();
            } catch (error) {
                if (version === loadVersion) { status.textContent = error.message; openPanel(); }
            }
        }
        async function upload(file) {
            if (!file || options.isBusy() || !cid) return;
            openPanel();
            var run = options.beginRequest(), documentId = api.newRequestId();
            var uploadPath = endpoint(documentId);
            run.request = {conversation_id: cid, request_id: documentId};
            options.setBusy(true);
            status.textContent = file.name + ' · 업로드·본문 읽기 중…';
            try {
                var result = await api.requestJson(uploadPath + '?filename=' + encodeURIComponent(file.name), {
                    method: 'POST', headers: {'Content-Type': 'application/pdf'}, body: file,
                    signal: run.controller.signal
                });
                options.checkRequest(run);
                updateItem(result); render();
                status.textContent = '문서를 읽었습니다. 사용할 작업을 확인하고 연결하세요.';
            } catch (error) {
                if (run.cancelled || error.name === 'AbortError') {
                    await options.reportStop(run);
                    status.textContent = 'PDF 읽기를 중지했습니다.';
                } else { status.textContent = error.message; }
            } finally {
                fileInput.value = '';
                options.endRequest(run); options.setBusy(false); updateControls();
            }
        }
        async function connect(id, task) {
            if (options.isBusy()) return;
            if (!task) { status.textContent = '사용할 작업을 선택하세요.'; return; }
            options.setBusy(true);
            try {
                var current = currentWorkspace();
                var result = await api.requestJson(endpoint(id) + '/link', {
                    method: 'PUT', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({task_type: task, workspace: current && current.task_type === task ? current : null})
                });
                updateItem(result); render();
                status.textContent = result.link.workspace ? '문서를 작업표의 참고자료로 연결했습니다.'
                    : '사용할 작업을 지정했습니다. 해당 작업표를 준비하면 연결됩니다.';
            } catch (error) { status.textContent = error.message; }
            finally { options.setBusy(false); updateControls(); }
        }
        async function attachPending(workspace) {
            if (!cid || !workspace) return;
            var version = loadVersion;
            var pending = items.filter(function (item) {
                return item.link && !item.link.workspace && item.link.task_type === workspace.task_type;
            });
            try {
                for (var item of pending) {
                    var result = await api.requestJson(endpoint(item.document_id) + '/link', {
                        method: 'PUT', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({task_type: workspace.task_type, workspace: workspace})
                    });
                    if (version !== loadVersion) return;
                    updateItem(result);
                }
                if (pending.length) {
                    render(); status.textContent = '대기 중인 참고자료를 ' + workspace.sheet_name + ' 작업표에 연결했습니다.';
                }
            } catch (error) {
                status.textContent = '작업표는 준비됐지만 참고자료 연결에 실패했습니다. ' + error.message;
                panel.hidden = false;
            }
        }
        async function showPage(id, number) {
            if (options.isBusy()) return;
            var item = items.find(function (value) { return value.document_id === id; });
            if (!item) return;
            number = Math.max(1, Math.min(item.page_count, Math.floor(Number(number) || 1)));
            var version = ++pageVersion;
            previewId = id; pageNumber = number; viewer.hidden = false;
            pageInput.value = String(number); pageInput.max = String(item.page_count);
            document.getElementById('document-preview-title').textContent = item.filename;
            document.getElementById('document-page-count').textContent = '/ ' + item.page_count + '쪽';
            pageBody.textContent = '내용을 불러오는 중…';
            try {
                var result = await api.requestJson(endpoint(id) + '/pages/' + number);
                if (version !== pageVersion) return;
                if (result.readable) window.markdownRenderer.render(pageBody, result.text);
                else pageBody.textContent = '읽을 수 있는 텍스트가 없는 페이지입니다. 스캔·사진·빈 페이지인지 원본을 확인하세요.';
            } catch (error) { if (version === pageVersion) pageBody.textContent = error.message; }
        }
        async function removeDocument(id) {
            if (options.isBusy()) return;
            options.setBusy(true);
            try {
                await api.requestJson(endpoint(id), {method: 'DELETE'});
                items = items.filter(function (item) { return item.document_id !== id; });
                if (previewId === id) { previewId = null; ++pageVersion; viewer.hidden = true; }
                render(); status.textContent = '참고자료를 제거했습니다.';
            } catch (error) { status.textContent = error.message; }
            finally { options.setBusy(false); updateControls(); }
        }
        picker.addEventListener('click', function () { if (!options.isBusy() && cid) fileInput.click(); });
        fileInput.addEventListener('change', function () { return upload(fileInput.files[0]); });
        toggle.addEventListener('click', function () { if (panel.hidden) openPanel(); else panel.hidden = true; });
        document.getElementById('documents-close').addEventListener('click', function () { panel.hidden = true; toggle.focus(); });
        document.getElementById('document-prev').addEventListener('click', function () { return showPage(previewId, pageNumber - 1); });
        document.getElementById('document-next').addEventListener('click', function () { return showPage(previewId, pageNumber + 1); });
        pageInput.addEventListener('change', function () { return showPage(previewId, pageInput.value); });
        render();
        return {load: load, updateControls: updateControls, attachPending: attachPending};
    };
})();
