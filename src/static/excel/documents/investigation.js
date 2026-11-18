"use strict";
(function () {
    window.createInvestigationController = function (options) {
        var cid = null, state = null, version = 0, readVersion = 0, editVersion = 0, dirty = false;
        var fields = [];
        function el(id) { return document.getElementById('investigation-' + id); }
        function endpoint() { return '/conversations/' + encodeURIComponent(cid) + '/investigation'; }
        function status(text) { el('status').textContent = text; }
        function open() { el('panel').hidden = false; el('title').focus(); }
        function node(tag, text) {
            var item = document.createElement(tag);
            if (text !== undefined) item.textContent = text;
            return item;
        }
        function markDirty() { editVersion++; dirty = true; status('수정한 내용은 아직 저장되지 않았어요.'); }
        function button(parent, text, action) {
            var item = node('button', text); item.type = 'button';
            item.addEventListener('click', action); parent.appendChild(item); return item;
        }
        function field(parent, label, tag, value, max) {
            var wrapper = node('label', label), input = node(tag);
            input.value = value; if (max) input.maxLength = max;
            if (tag === 'textarea') input.rows = 3;
            input.addEventListener('input', markDirty);
            input.addEventListener('change', markDirty);
            wrapper.appendChild(input); parent.appendChild(wrapper); return input;
        }
        function updateControls() {
            el('panel').querySelectorAll('button,input,textarea,select').forEach(function (control) {
                control.disabled = options.isBusy() || !cid || !state;
            });
            el('close').disabled = false;
            el('reload').disabled = options.isBusy() || !cid;
        }
        function activeOptions(value) {
            var select = el('active'); select.replaceChildren();
            var empty = node('option', '선택하지 않음'); empty.value = ''; select.appendChild(empty);
            fields.forEach(function (row) {
                if (!row.condition.condition_id) return;
                var item = node('option', row.title.value); item.value = row.condition.condition_id;
                select.appendChild(item);
            });
            select.value = value || '';
        }
        function addCondition(condition) {
            var article = node('article'); article.className = 'investigation-condition';
            var row = {condition: condition, article: article};
            row.title = field(article, '조건 이름', 'input', condition.title, 120);
            row.description = field(article, '찾을 대상과 조건', 'textarea', condition.description, 2000);
            row.status = field(article, '확인 상태', 'select', '', null);
            [['candidate', '검토 전 후보'], ['confirmed', '사용자 확인'], ['needs_review', '재확인 필요']].forEach(function (entry) {
                var option = node('option', entry[1]); option.value = entry[0]; row.status.appendChild(option);
            });
            row.status.value = condition.status;
            if (condition.edited) article.appendChild(node('p', '사용자가 작성·수정한 조건'));
            if (condition.uncertainty) article.appendChild(node('p', '확인할 부분: ' + condition.uncertainty));
            if (condition.review_reason) article.appendChild(node('p', condition.review_reason));
            var links = node('fieldset'); links.appendChild(node('legend', '연결할 데이터 열 · 선택 사항'));
            row.columns = (state.columns || []).map(function (column) {
                var label = node('label'), input = node('input'); input.type = 'checkbox';
                input.checked = (condition.column_ids || []).includes(column.column_id);
                input.addEventListener('change', markDirty);
                label.appendChild(input); label.appendChild(node('span', column.header)); links.appendChild(label);
                return {id: column.column_id, input: input};
            });
            if (!row.columns.length) links.appendChild(node('p', '작업표를 연결하면 열을 선택할 수 있어요.'));
            article.appendChild(links);
            var evidence = node('details'); evidence.appendChild(node('summary', '문서 근거'));
            (condition.evidence || []).forEach(function (item) {
                evidence.appendChild(node('p', item.filename + ' · ' + item.page_number + '쪽'));
                evidence.appendChild(node('blockquote', item.quote));
            });
            if (!(condition.evidence || []).length) evidence.appendChild(node('p', '사용자가 추가한 조건이에요.'));
            article.appendChild(evidence);
            button(article, '조건 제거', function () {
                fields = fields.filter(function (value) { return value !== row; });
                article.hidden = true; activeOptions(el('active').value); markDirty();
            });
            fields.push(row); el('conditions').appendChild(article);
        }
        function render() {
            fields = []; el('conditions').replaceChildren(); el('warnings').replaceChildren();
            el('goal').value = state ? state.goal : '';
            el('workspace').textContent = state && state.workspace ? '연결 작업표: ' + state.workspace.sheet_name : '아직 작업표에 연결하지 않았어요.';
            if (state) {
                state.conditions.forEach(addCondition);
                Object.keys(state.document_notes).forEach(function (id) {
                    state.document_notes[id].forEach(function (note) { el('warnings').appendChild(node('p', note)); });
                });
            }
            activeOptions(state && state.active_condition_id); dirty = false; updateControls();
        }
        async function refresh(force) {
            if (!cid) return;
            if (dirty && !force) { status('자료가 변경됐어요. 저장 전 내용을 확인하고, 필요하면 저장값을 다시 불러오세요.'); return; }
            var expected = version, reading = ++readVersion, edits = editVersion;
            try {
                var result = await options.api.requestJson(endpoint());
                if (expected !== version || reading !== readVersion) return;
                if (edits !== editVersion) { status("수정 중인 내용을 유지했어요. 저장하거나 다시 불러오세요."); return; }
                state = result; render(); status('조사 조건 ' + state.conditions.length + '개를 불러왔어요.'); return true;
            } catch (error) { if (expected === version) status(error.message); }
        }
        async function load(conversationId) {
            version++; cid = conversationId; state = null; dirty = false; render();
            el('panel').hidden = true; status(''); await refresh(true);
        }
        function payload() {
            return {revision: state.revision, goal: el('goal').value,
                active_condition_id: el('active').value || null,
                conditions: fields.map(function (row) {
                    return {condition_id: row.condition.condition_id || null, title: row.title.value,
                        description: row.description.value, status: row.status.value,
                        column_ids: row.columns.filter(function (c) { return c.input.checked; }).map(function (c) { return c.id; })};
                })};
        }
        async function save(bind) {
            if (!state || options.isBusy()) return;
            var expected = version, url = endpoint(), data = payload();
            ++readVersion;
            options.setBusy(true); updateControls();
            try {
                data.workspace = await options.getWorkspace(); data.bind_workspace = bind;
                if (expected !== version) return;
                var result = await options.api.requestJson(url, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
                if (expected !== version) return;
                state = result; render(); status('조사 조건을 저장했어요. 다음 대화에서도 이 조건을 참고해요. Excel 셀은 바꾸지 않았어요.');
            } catch (error) { if (expected === version) status(error.message); }
            finally { options.setBusy(false); updateControls(); }
        }
        async function extract(documentId) {
            if (options.isBusy() || !cid) return;
            open();
            if (dirty) { status('수정 중인 조사 조건을 먼저 저장해 주세요.'); return; }
            var requestedVersion = version;
            if (!await refresh(true) || requestedVersion !== version || options.isBusy()) return;
            if (Object.prototype.hasOwnProperty.call(state.document_notes, documentId)) {
                status('이미 읽은 문서예요. 저장한 수정·삭제 내용을 유지했어요.'); return;
            }
            var expected = version, url = endpoint(), conversationId = cid;
            var run = options.beginRequest(), requestId = options.api.newRequestId();
            run.request = {conversation_id: conversationId, request_id: requestId};
            options.setBusy(true); updateControls(); status('PDF에서 조사 조건과 근거를 읽고 있어요…');
            try {
                var result = await options.api.requestJson(url + '/extractions/' + requestId, {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, signal: run.controller.signal,
                    body: JSON.stringify({document_id: documentId, revision: state.revision})
                });
                options.checkRequest(run);
                if (expected !== version) return;
                state = result; render(); status('조건 후보를 읽었어요. 내용을 수정하거나 확인 상태를 바꾸고 저장하세요. 거래 행은 아직 선별하지 않았어요.');
            } catch (error) {
                if (expected !== version) return;
                if (run.cancelled || error.name === 'AbortError') {
                    await options.reportStop(run); status('조사 조건 읽기를 중지했어요. 저장값을 다시 불러와 상태를 확인할 수 있어요.');
                } else status(error.message);
            } finally { options.endRequest(run); options.setBusy(false); updateControls(); }
        }
        el('goal').addEventListener('input', markDirty); el('active').addEventListener('change', markDirty);
        el('save').addEventListener('click', function () { return save(false); });
        el('bind').addEventListener('click', function () { return save(true); });
        el('reload').addEventListener('click', function () { if (!options.isBusy()) return refresh(true); });
        el('add').addEventListener('click', function () {
            if (!state || options.isBusy()) return;
            addCondition({title: '', description: '', status: 'candidate', column_ids: [], evidence: []}); markDirty();
        });
        el('toggle').addEventListener('click', function () { if (el('panel').hidden) { open(); return refresh(); } el('panel').hidden = true; });
        el('close').addEventListener('click', function () { el('panel').hidden = true; el('toggle').focus(); });
        render();
        return {load: load, refresh: refresh, extract: extract, updateControls: updateControls,
            open: async function () { open(); await refresh(); }};
    };
})();
