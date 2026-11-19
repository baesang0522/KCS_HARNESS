"use strict";
(function () {
    window.createDocumentsController = function (options) {
        var api = options.api, cid = null, items = [], version = 0, reflecting = false;
        var panel = document.getElementById('documents-panel'), list = document.getElementById('documents-list');
        var status = document.getElementById('documents-status'), input = document.getElementById('document-file');
        var picker = document.getElementById('document-add'), toggle = document.getElementById('documents-toggle');
        var composer = document.getElementById('composer');
        var applyReview = document.getElementById('documents-apply');
        function base() { return '/conversations/' + encodeURIComponent(cid) + '/documents'; }
        function endpoint(id) { return base() + '/' + encodeURIComponent(id); }
        function node(tag, text) { var element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
        function show(open) {
            panel.hidden = !open; toggle.textContent = open ? '추출내용 닫기' : '추출내용 보기' + (items.length ? ' (' + items.length + ')' : '');
            toggle.setAttribute('aria-expanded', String(open));
        }
        function updateControls() {
            picker.disabled = options.isBusy() || !cid;
            panel.querySelectorAll('button,input').forEach(function (el) { el.disabled = options.isBusy(); });
            document.getElementById('documents-close').disabled = false;
            applyReview.disabled = options.isBusy() || reflecting || !cid || !options.applyReview || !items.some(function (item) { return options.reviewInfo && options.reviewInfo(item.document_id).ready; });
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
                row.appendChild(node('p', info.ready ? '검토 시트에서 수정한 뒤 아래 ‘수정 내용 반영’을 누르세요.' : '채팅으로 이 PDF의 추출 재시도를 요청하세요.'));
                list.appendChild(row);
            });
            updateControls();
        }
        async function refresh() {
            var expected = version, result = await api.requestJson(base());
            if (expected !== version) return;
            items = result.documents; render();
        }
        async function load(id) {
            version++; cid = id; items = [];
            status.textContent = ''; show(false); render();
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
        function close() { show(false); toggle.focus({preventScroll: true}); }
        document.getElementById('documents-close').addEventListener('click', close);
        function escape(event) { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(); } }
        panel.addEventListener('keydown', escape);
        toggle.addEventListener('keydown', escape);
        applyReview.addEventListener('click', async function () {
            if (applyReview.disabled || reflecting) return;
            reflecting = true; updateControls(); close();
            try { await options.applyReview(); }
            catch (error) { status.textContent = error.message; show(true); }
            finally { reflecting = false; updateControls(); }
        });
        render();
        return {items: function () { return items.slice(); }, load: load, refresh: refresh, render: render, updateControls: updateControls};
    };
})();
