"use strict";
(function () {
    window.createInvestigationController = function (options) {
        var cid = null, state = null, version = 0, binding = null, readySheets = new Set();
        var sheet = options.sheet || window.investigationSheet;
        function endpoint() { return '/conversations/' + encodeURIComponent(cid) + '/investigation'; }
        function status(text) { document.getElementById('documents-status').textContent = text; }
        function show() {
            document.getElementById('documents-panel').hidden = false;
            document.getElementById('documents-toggle').textContent = '추출내용 접기';
            document.getElementById('documents-toggle').setAttribute('aria-expanded', 'true');
        }
        function render() {
            var target = document.getElementById('investigation-workspace');
            target.textContent = state && state.workspace ? '작업표: ' + state.workspace.sheet_name : '작업표를 준비하면 자동으로 연결돼요.';
            if (options.onChanged) options.onChanged();
        }
        async function refresh() {
            var expected = version, result = await options.api.requestJson(endpoint());
            if (expected !== version) throw new Error('대화가 바뀌었어요.');
            state = result; render(); return state;
        }
        async function load(id) {
            version++; cid = id; state = null; binding = null; readySheets = new Set();
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
        async function bind(target) {
            if (!cid || !target) return;
            validateWorkspace(target);
            if (state && state.workspace && sameTarget(state.workspace, target) && state.workspace.sheet_name === target.sheet_name) return;
            if (binding) return binding;
            var expected = version, url = endpoint();
            binding = (async function () {
                var result = await options.api.requestJson(url + '/workspace', {
                    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(target)});
                if (expected !== version) throw new Error('대화가 바뀌었어요.');
                state = result; render();
            })();
            try { await binding; } finally { if (expected === version) binding = null; }
        }
        async function prepare() {
            await refresh();
            await bind(options.getWorkspace());
        }
        async function extract(documentId, filename) {
            if (options.isBusy() || !cid) return;
            var expected = version, run = options.beginRequest(), url = endpoint();
            options.setBusy(true); show();
            try {
                await prepare(); options.checkRequest(run);
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
                    else status(error.message);
                }
                return false;
            } finally { options.endRequest(run); options.setBusy(false); render(); }
        }
        async function apply(documentId) {
            if (options.isBusy() || !cid) return;
            var expected = version, conversationId = cid, url = endpoint();
            options.setBusy(true); show();
            try {
                await prepare();
                var draft = await sheet.read(conversationId, documentId);
                if (!draft) throw new Error('먼저 검토 시트를 열어 주세요.');
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
                catch (error) { throw new Error('서버에는 반영했지만 시트 기록 저장에 실패했어요. 같은 버튼으로 다시 반영해 주세요. ' + error.message); }
                if (expected === version) { render(); status('수정 내용을 반영했어요. 이후 대화에서는 이 값을 사용해요. 거래 행 추출은 아직 실행하지 않았어요.'); }
            } catch (error) { if (expected === version) status(error.message); }
            finally { options.setBusy(false); }
        }
        async function ensureSynced() {
            if (!cid) return;
            await prepare();
            for (var did of Object.keys(state.reviews || {})) {
                var draft = await sheet.read(cid, did);
                if (draft && sheet.canonical(draft.rows) !== sheet.canonical(state.reviews[did])) {
                    show(); throw new Error('검토 시트에 반영하지 않은 수정이 있어요. ‘수정 내용 반영’을 먼저 눌러 주세요.');
                }
            }
        }
        function info(did) {
            return state ? {ready: Object.prototype.hasOwnProperty.call(state.document_notes, did) && readySheets.has(did),
                count: (state.reviews[did] || []).length, warnings: state.document_notes[did] || []} : {ready: false, count: 0, warnings: []};
        }
        return {load: load, refresh: refresh, prepare: prepare, bind: bind, validateWorkspace: validateWorkspace,
            extract: extract, apply: apply, info: info, ensureSynced: ensureSynced,
            open: async function () { show(); await refresh(); }};
    };
})();
