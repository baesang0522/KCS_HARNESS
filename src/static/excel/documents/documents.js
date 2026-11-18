"use strict";
(function () {
    window.createDocumentsController = function (options) {
        var api = options.api, cid = null, items = [], previewId = null, pageNumber = 1, version = 0, pageVersion = 0;
        var panel = document.getElementById('documents-panel'), list = document.getElementById('documents-list');
        var status = document.getElementById('documents-status'), input = document.getElementById('document-file');
        var picker = document.getElementById('document-add'), toggle = document.getElementById('documents-toggle');
        var viewer = document.getElementById('document-preview'), pageInput = document.getElementById('document-page');
        var body = document.getElementById('document-page-body'), composer = document.getElementById('composer');
        function base() { return '/conversations/' + encodeURIComponent(cid) + '/documents'; }
        function endpoint(id) { return base() + '/' + encodeURIComponent(id); }
        function node(tag, text) { var element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
        function show(open) {
            panel.hidden = !open; toggle.textContent = open ? '추출내용 접기' : '추출내용 보기' + (items.length ? ' (' + items.length + ')' : '');
            toggle.setAttribute('aria-expanded', String(open));
        }
        function updateControls() {
            picker.disabled = options.isBusy() || !cid;
            panel.querySelectorAll('button,input').forEach(function (el) { el.disabled = options.isBusy(); });
            document.getElementById('documents-close').disabled = false;
        }
        function button(parent, label, action) {
            var b = node('button', label); b.type = 'button'; b.addEventListener('click', action); parent.appendChild(b);
        }
        function render() {
            list.replaceChildren(); show(!panel.hidden);
            items.forEach(function (item) {
                var row = node('article'); row.className = 'document-item'; row.appendChild(node('strong', item.filename));
                var info = options.reviewInfo ? options.reviewInfo(item.document_id) : {ready: false, warnings: []};
                row.appendChild(node('p', item.page_count + '쪽 · ' + (info.ready ? info.count + '개 항목' : '추출 대기')));
                if (item.unreadable_pages.length) row.appendChild(node('p', '텍스트 없음: ' + item.unreadable_pages.join(', ') + '쪽'));
                info.warnings.forEach(function (warning) { row.appendChild(node('p', warning)); });
                var actions = node('div'); actions.className = 'document-actions';
                button(actions, info.ready ? '검토 시트 열기' : '추출 다시 시도', function () { return options.readConditions(item.document_id, item.filename); });
                if (info.ready && options.preprocessReview) button(actions, '전처리', function () { return options.preprocessReview(item.document_id, item.filename); });
                if (info.ready) button(actions, '수정 내용 반영', function () { return options.applyReview(item.document_id); });
                button(actions, '원문 보기', function () { return showPage(item.document_id, 1); });
                row.appendChild(actions); list.appendChild(row);
            });
            updateControls();
        }
        async function refresh() {
            var expected = version, result = await api.requestJson(base());
            if (expected !== version) return;
            items = result.documents; render();
        }
        async function load(id) {
            version++; cid = id; items = []; previewId = null; pageVersion++;
            viewer.hidden = true; body.textContent = ''; status.textContent = ''; show(false); render();
            try { await refresh(); } catch (error) { status.textContent = error.message; show(true); }
        }
        async function upload(file) {
            if (!file || options.isBusy() || !cid) return;
            show(true);
            if (!/\.pdf$/i.test(file.name)) { status.textContent = 'PDF 파일만 첨부할 수 있어요.'; return false; }
            if (file.size > 25 * 1024 * 1024) { status.textContent = 'PDF는 25MB 이하로 첨부해 주세요.'; return false; }
            var expected = version, documentId = api.newRequestId(), run = options.beginRequest(), url = endpoint(documentId), uploaded = false;
            run.request = {conversation_id: cid, request_id: documentId}; options.setBusy(true);
            status.textContent = file.name + ' · PDF 본문 읽는 중…';
            try {
                if (options.beforeUpload) await options.beforeUpload();
                options.checkRequest(run);
                if (expected !== version) return;
                var result = await api.requestJson(url + '?filename=' + encodeURIComponent(file.name), {
                    method: 'POST', headers: {'Content-Type': 'application/pdf'}, body: file, signal: run.controller.signal});
                options.checkRequest(run);
                if (expected !== version) return;
                items.push(result); render(); uploaded = true;
            } catch (error) {
                if (expected === version) {
                    if (run.cancelled || error.name === 'AbortError') { await options.reportStop(run); status.textContent = 'PDF 읽기를 중지했어요.'; }
                    else status.textContent = error.message;
                }
            } finally { input.value = ''; options.endRequest(run); options.setBusy(false); updateControls(); }
            if (uploaded && expected === version && options.readConditions) return options.readConditions(documentId, file.name);
            return uploaded && expected === version;
        }
        async function uploadFiles(files) {
            if (options.isBusy()) return;
            var expected = version;
            for (var file of Array.from(files || [])) {
                if (expected !== version) return;
                if (await upload(file) === false) return;
            }
        }
        async function showPage(id, number) {
            if (options.isBusy()) return;
            var item = items.find(function (entry) { return entry.document_id === id; }); if (!item) return;
            number = Math.max(1, Math.min(item.page_count, Math.floor(Number(number) || 1)));
            var reading = ++pageVersion; previewId = id; pageNumber = number; viewer.hidden = false;
            pageInput.value = String(number); pageInput.max = String(item.page_count);
            document.getElementById('document-preview-title').textContent = item.filename + ' · 원문 (읽기 전용)';
            document.getElementById('document-page-count').textContent = '/ ' + item.page_count + '쪽';
            body.textContent = '내용을 불러오는 중…';
            try {
                var result = await api.requestJson(endpoint(id) + '/pages/' + number);
                if (reading !== pageVersion) return;
                if (result.readable) window.markdownRenderer.render(body, result.text);
                else body.textContent = '읽을 수 있는 텍스트가 없는 페이지예요. 원본을 확인해 주세요.';
            } catch (error) { if (reading === pageVersion) body.textContent = error.message; }
        }
        picker.addEventListener('click', function () { if (!options.isBusy() && cid) input.click(); });
        input.addEventListener('change', function () { return uploadFiles(input.files); });
        composer.addEventListener('dragover', function (event) {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
                event.preventDefault(); composer.setAttribute('data-file-drag', 'true');
                event.dataTransfer.dropEffect = options.isBusy() ? 'none' : 'copy';
            }
        });
        composer.addEventListener('dragleave', function (event) {
            if (!composer.contains(event.relatedTarget)) composer.setAttribute('data-file-drag', 'false');
        });
        composer.addEventListener('drop', function (event) {
            event.preventDefault(); composer.setAttribute('data-file-drag', 'false');
            if (options.isBusy()) { show(true); status.textContent = '진행 중인 작업이 끝나면 PDF를 놓아 주세요.'; return; }
            return uploadFiles(event.dataTransfer && event.dataTransfer.files);
        });
        toggle.addEventListener('click', function () { show(panel.hidden); });
        document.getElementById('documents-close').addEventListener('click', function () { show(false); toggle.focus(); });
        document.getElementById('document-prev').addEventListener('click', function () { return showPage(previewId, pageNumber - 1); });
        document.getElementById('document-next').addEventListener('click', function () { return showPage(previewId, pageNumber + 1); });
        pageInput.addEventListener('change', function () { return showPage(previewId, pageInput.value); });
        render();
        return {load: load, refresh: refresh, render: render, updateControls: updateControls};
    };
})();
