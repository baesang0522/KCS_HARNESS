"use strict";
(function () {
    window.createInvestigationController = function (options) {
        var cid = null, state = null, version = 0, binding = null, readySheets = new Set(), extracting = new Set(), failed = new Set();
        var sheet = options.sheet || window.investigationSheet;
        function endpoint() { return '/conversations/' + encodeURIComponent(cid) + '/investigation'; }
        function status(text) { document.getElementById('documents-status').textContent = text; if (options.messages) options.messages.say(text); }
        function progress(text) {
            document.getElementById('documents-status').textContent = text;
            document.getElementById('notice').textContent = text + ' · 보내기 위치의 중지 버튼으로 멈출 수 있어요.';
        }
        function waitForRead(run, pending) {
            if (!run) return pending;
            // Excel.run 자체는 중단할 수 없으므로 읽기 응답 대기만 해제하고 늦은 결과는 버린다.
            return new Promise(function (resolve, reject) {
                var signal = run.controller.signal, settled = false;
                function finish(callback, value) {
                    if (settled) return;
                    settled = true; signal.removeEventListener('abort', stop); callback(value);
                }
                function stop() { finish(reject, new DOMException('수정 내용 확인을 중지했습니다.', 'AbortError')); }
                signal.addEventListener('abort', stop);
                Promise.resolve(pending).then(function (value) { finish(resolve, value); }, function (error) { finish(reject, error); });
                if (signal.aborted) stop();
            });
        }
        function show() {
            document.getElementById('documents-panel').hidden = false;
            document.getElementById('documents-toggle').textContent = '추출내용 닫기';
            document.getElementById('documents-toggle').setAttribute('aria-expanded', 'true');
        }
        function render() {
            var target = document.getElementById('investigation-workspace');
            target.textContent = state && state.workspace ? '작업표: ' + state.workspace.sheet_name : '작업표를 준비하면 자동으로 연결돼요.';
            if (options.onChanged) options.onChanged();
        }
        async function refresh(run) {
            var expected = version, result = await waitForRead(run, options.api.requestJson(endpoint(), run ? {signal: run.controller.signal} : undefined));
            if (run) options.checkRequest(run);
            if (expected !== version) throw new Error('대화가 바뀌었어요.');
            state = result; render(); return state;
        }
        async function load(id) {
            version++; cid = id; state = null; binding = null; readySheets = new Set(); extracting = new Set(); failed = new Set();
            var expected = version;
            try {
                await refresh();
                for (var did of Object.keys(state.reviews || {})) {
                    var ready = await sheet.isReady(id, did, state.reviews[did]);
                    if (expected !== version) return;
                    if (ready) readySheets.add(did);
                }
                render();
            } catch (error) { if (expected === version) status(error.message); }
        }
        function sameTarget(a, b) {
            return a && b && ['workspace_id', 'worksheet_id', 'table_id'].every(function (key) { return String(a[key]) === String(b[key]); });
        }
        function validateWorkspace(target) {
            if (!state) throw new Error('조사 정보를 아직 읽지 못했어요. 화면을 새로 불러와 주세요.');
            if (state.workspace && !sameTarget(state.workspace, target)) throw new Error('이 대화는 이미 작업표 하나로 조사 중이에요. 새 조사는 새 대화에서 시작하세요.');
        }
        async function bind(target, run) {
            if (!cid || !target) return;
            validateWorkspace(target);
            if (state && state.workspace && sameTarget(state.workspace, target) && state.workspace.sheet_name === target.sheet_name) return;
            if (binding) return waitForRead(run, binding);
            var expected = version, url = endpoint();
            binding = (async function () {
                var result = await waitForRead(run, options.api.requestJson(url + '/workspace', {
                    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(target), signal: run && run.controller.signal}));
                if (run) options.checkRequest(run);
                if (expected !== version) throw new Error('대화가 바뀌었어요.');
                state = result; render();
            })();
            try { await binding; } finally { if (expected === version) binding = null; }
        }
        async function prepare(run) {
            await refresh(run);
            await bind(options.getWorkspace(), run);
            if (run) options.checkRequest(run);
        }
        async function extract(documentId, filename) {
            if (options.isBusy() || !cid) return;
            var expected = version, run = options.beginRequest(), url = endpoint();
            extracting.add(documentId); failed.delete(documentId);
            options.setBusy(true); show(); render();
            try {
                await prepare(run); options.checkRequest(run);
                if (expected !== version) return;
                if (!Object.prototype.hasOwnProperty.call(state.document_notes, documentId)) {
                    var requestId = options.api.newRequestId();
                    run.request = {conversation_id: cid, request_id: requestId};
                    status(filename + ' · AI가 회사·품목과 근거를 정리하고 있어요…');
                    var result = await options.api.requestJson(url + '/extractions/' + requestId, {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({document_id: documentId, revision: state.revision}), signal: run.controller.signal});
                    options.checkRequest(run);
                    if (expected !== version) return;
                    state = result; render();
                }
                options.checkRequest(run);
                // Excel 작성 중에는 중지 버튼 대신 완료/실패를 기다린다. 사용자 수정 시트는 재작성하지 않는다.
                options.endRequest(run); options.setBusy(true);
                await sheet.ensure(cid, documentId, filename, state.reviews[documentId] || []);
                if (expected === version) {
                    readySheets.add(documentId);
                    status(filename + ' · 검토 시트를 만들었어요. Excel 시트 탭에서 확인·수정한 뒤 ‘수정 내용 반영’을 눌러 주세요.');
                }
                return true;
            } catch (error) {
                if (expected === version) {
                    if (run.cancelled || error.name === 'AbortError') { await options.reportStop(run); status('추출을 중지했어요. 첨부한 PDF는 유지돼요.'); }
                    else { failed.add(documentId); status(error.message); }
                }
                return false;
            } finally { if (expected === version) extracting.delete(documentId); options.endRequest(run); options.setBusy(false); render(); }
        }
        async function apply(documentId, approvedDraft, batch) {
            if (options.isBusy() || !cid) return;
            var expected = version, conversationId = cid, url = endpoint();
            options.setBusy(true);
            try {
                await prepare();
                if (!await sheet.isReady(conversationId, documentId, state.reviews[documentId] || [])) throw new Error('검토 시트 작성이 완료되지 않았어요. 해당 PDF의 추출 재시도를 요청해 주세요. 기존 시트의 수정 내용은 유지돼요.');
                var draft = await sheet.read(conversationId, documentId);
                if (!draft) throw new Error('먼저 검토 시트를 열어 주세요.');
                if (approvedDraft && sheet.canonical(draft.rows) !== sheet.canonical(approvedDraft.rows)) throw new Error('확인 이후 검토 시트가 바뀌었어요. 수정 반영을 다시 요청하세요.');
                if (expected !== version) return;
                // 저장 응답 유실/시트 메타데이터 저장 실패 후에도 같은 수정값을 안전하게 재반영한다.
                var current = state.reviews[documentId] || [];
                var confirmed = state.conditions.filter(function (c) { return c.source_document_id === documentId; }).every(function (c) { return c.status === 'confirmed'; });
                if (sheet.canonical(current) !== sheet.canonical(draft.rows) || !confirmed) {
                    var saved = await options.api.requestJson(url + '/reviews/' + encodeURIComponent(documentId), {
                        method: 'PUT', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({revision: state.revision, expected_rows: draft.baseline, rows: draft.rows})});
                    if (expected !== version) return;
                    state = saved;
                }
                try { await sheet.markSaved(conversationId, documentId, state.reviews[documentId] || []); }
                catch (error) { throw new Error('서버에는 반영했지만 시트 기록 저장에 실패했어요. 채팅으로 수정 내용 반영을 다시 요청해 주세요. ' + error.message); }
                if (expected === version) { render(); if (!batch) status('수정 내용을 반영했어요. 이후 대화에서는 이 값을 사용해요.'); return true; }
            } catch (error) { if (expected === version) status((batch && batch.completed ? 'PDF ' + batch.completed + '개는 반영했지만 나머지 반영을 중단했어요. ' : '') + error.message); }
            finally { options.setBusy(false); }
        }
        async function ensureSynced() {
            if (!cid) return;
            await prepare();
            for (var did of Object.keys(state.reviews || {})) {
                var draft = await sheet.read(cid, did);
                if (draft && sheet.canonical(draft.rows) !== sheet.canonical(state.reviews[did])) {
                    show(); throw new Error('검토 시트에 반영하지 않은 수정이 있어요. 추출내용의 ‘수정 내용 반영’을 눌러 주세요. 채팅으로도 요청할 수 있어요.');
                }
            }
        }
        async function previewApply(documentIds) {
            if (options.isBusy()) return;
            var run = options.beginRequest();
            options.setBusy(true);
            var drafts = [], conversationId = cid, expected = version;
            try {
                progress('PDF 수정 반영 준비 · 서버의 조사 상태를 확인하고 있어요…');
                await prepare(run);
                var ids = documentIds || Object.keys(state.reviews || {});
                if (!ids.length) throw new Error('PDF 추출이 완료되지 않아 반영할 검토 시트가 없어요. 채팅으로 해당 PDF의 추출 재시도를 요청해 주세요.');
                for (var id of ids) {
                    options.checkRequest(run);
                    progress('PDF 수정 반영 준비 · Excel 검토 시트를 읽고 있어요… ' + (drafts.length + 1) + '/' + ids.length);
                    if (!Object.prototype.hasOwnProperty.call(state.document_notes, id)) throw new Error('PDF 추출이 완료되지 않았어요. 채팅으로 해당 PDF의 추출 재시도를 요청해 주세요.');
                    if (!await waitForRead(run, sheet.isReady(cid, id, state.reviews[id] || []))) throw new Error('검토 시트 작성이 완료되지 않았어요. 해당 PDF의 추출 재시도를 요청해 주세요. 기존 시트의 수정 내용은 유지돼요.');
                    options.checkRequest(run);
                    var draft = await waitForRead(run, sheet.read(cid, id));
                    options.checkRequest(run);
                    if (!draft) throw new Error('PDF 검토 시트를 먼저 준비해 주세요.');
                    if (version !== expected) return;
                    readySheets.add(id); failed.delete(id);
                    var current = state.reviews[id] || [];
                    var changed = sheet.canonical(draft.rows) !== sheet.canonical(current) || sheet.canonical(draft.baseline) !== sheet.canonical(current);
                    var pending = state.conditions.some(function (condition) { return condition.source_document_id === id && condition.status !== 'confirmed'; });
                    drafts.push({id: id, draft: draft, changed: changed, pending: pending});
                }
                var changedDrafts = drafts.filter(function (item) { return item.changed; });
                drafts = changedDrafts.length ? changedDrafts : drafts.filter(function (item) { return item.pending; });
                if (!drafts.length) { status('반영할 수정 내용이 없어요.'); return; }
                var label = changedDrafts.length ? '수정 내용' : '검토 내용';
                if (version !== expected) return;
                var rows = drafts.flatMap(function (item) { return item.draft.rows.map(function (row) { return [{supplier: '거래처', item: '품목', other: '기타'}[row.target.kind] + ' · ' + sheet.values(row).slice(0, -1).join(' · '), (row.source_pages || []).join(', ')]; }); });
                options.messages.confirm('PDF ' + drafts.length + '개의 ' + label + ' ' + rows.length + '건을 반영할까?', {apply: async function () {
                    if (cid !== conversationId || version !== expected) throw new Error('조사가 바뀌었어요. 다시 요청하세요.');
                    var batch = {completed: 0};
                    for (var item of drafts) {
                        if (!await apply(item.id, item.draft, batch)) return;
                        batch.completed++;
                    }
                    status('PDF ' + batch.completed + '개의 ' + label + '을 반영했어요.');
                }, cancel: function () { status('조사 조건 반영을 취소했어요. 검토 시트 수정값은 남아 있어요.'); }}, ['조건 내용', '근거 페이지'], rows);
            } catch (error) {
                if (run.cancelled || error.name === 'AbortError') {
                    await options.reportStop(run);
                    if (version === expected) status('수정 반영 준비를 중지했어요. 검토 시트의 수정값은 그대로이며 다시 반영을 요청할 수 있어요.');
                    return;
                }
                throw error;
            } finally {
                options.endRequest(run);
                document.getElementById('notice').textContent = '';
                options.setBusy(false); if (version === expected) render();
            }
        }
        function info(did) {
            return state ? {ready: Object.prototype.hasOwnProperty.call(state.document_notes, did) && readySheets.has(did),
                processing: extracting.has(did), failed: failed.has(did), count: (state.reviews[did] || []).length, warnings: state.document_notes[did] || []} : {ready: false, count: 0, warnings: []};
        }
        async function conditionVersions() {
            if (!cid) return null;
            await refresh();
            return Object.assign({}, state.condition_versions || {});
        }
        async function reviewContext() {
            if (!cid || !state || !sheet || !sheet.context) return [];
            var expected = version, entries = [];
            for (var did of Object.keys(state.reviews || {})) {
                entries = entries.concat(await sheet.context(cid, did));
                if (expected !== version) throw new Error('대화가 바뀌었어요.');
            }
            return entries;
        }
        return {reviewContext: reviewContext, conditionVersions: conditionVersions, load: load, refresh: refresh, prepare: prepare, bind: bind, validateWorkspace: validateWorkspace,
            extract: extract, apply: apply, previewApply: previewApply, info: info, ensureSynced: ensureSynced,
            open: async function () { show(); await refresh(); }};
    };
})();
