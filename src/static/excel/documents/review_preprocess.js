"use strict";
(function () {
    window.createReviewPreprocess = function (options) {
        var sheet = options.sheet || window.investigationSheet, target = null, columns = [], pending = null, version = 0;
        function el(name) { return document.getElementById('review-clean-' + name); }
        function status(text) { el('status').textContent = text; }
        function updateControls() {
            el('panel').querySelectorAll('button,input,select,textarea').forEach(function (node) { node.disabled = options.isBusy(); });
            el('apply').disabled = options.isBusy() || !pending;
            el('preview').disabled = options.isBusy() || !target;
        }
        function invalidate() { pending = null; el('examples').replaceChildren(); updateControls(); }
        function reset() { version++; target = null; columns = []; invalidate(); el('panel').hidden = true; }
        function rulesEditor() {
            el('rules').replaceChildren(); el('words').value = '';
            Array.from(document.getElementById('op-rules').children).forEach(function (source) {
                var row = source.cloneNode(true), input = row.querySelector('input'), button = row.querySelector('button');
                input.checked = false; input.disabled = false; button.disabled = false;
                input.addEventListener('change', invalidate);
                button.addEventListener('click', function () {
                    var siblings = Array.from(el('rules').children), index = siblings.indexOf(row);
                    if (index > 0) el('rules').insertBefore(row, siblings[index - 1]);
                    invalidate();
                });
                el('rules').appendChild(row);
            });
        }
        async function open(documentId, filename) {
            if (options.isBusy()) return;
            reset(); var expected = version;
            if (options.closeTaskCards) options.closeTaskCards();
            var next = {cid: options.getConversationId(), did: documentId};
            options.setBusy(true); el('panel').hidden = false;
            document.getElementById('documents-panel').hidden = false;
            el('title').textContent = filename + ' · 전처리'; status('검토 표의 열을 확인하고 있어요…');
            try {
                var result = await sheet.preprocessTargets(next.cid, next.did);
                if (expected !== version) return;
                target = next; columns = result; el('column').replaceChildren(); rulesEditor();
                columns.forEach(function (column, index) {
                    var option = document.createElement('option'); option.value = String(index); option.textContent = column.label; el('column').appendChild(option);
                });
                var company = columns.findIndex(function (column) { return column.kind === 'supplier' && column.column_index === 2; });
                el('column').value = String(company >= 0 ? company : 0);
                status('원하는 전처리를 각각 선택하세요. 결과는 검토 시트에만 적용되며, 조사 조건에는 ‘수정 내용 반영’으로 저장해요.');
                el('title').focus();
            } catch (error) { if (expected === version) status(error.message); }
            finally { options.setBusy(false); updateControls(); }
        }
        async function preview() {
            if (options.isBusy() || !target) return;
            invalidate(); var expected = version, selected = target;
            options.setBusy(true); status('변경 내용을 확인하고 있어요…');
            try {
                var rules = window.readPreprocessRules(el('rules'), el('words').value);
                if (!rules.length) throw new Error('실행할 전처리를 하나 이상 선택하세요.');
                var column = columns[Number(el('column').value)];
                if (!column) throw new Error('처리할 열을 선택하세요.');
                var snapshot = await sheet.readPreprocess(selected.cid, selected.did, column);
                if (expected !== version) return;
                var rows = snapshot.values.map(function (row, index) {
                    return {excel_row: snapshot.row_start + index + 1, values: [String(row[snapshot.column_index])]};
                });
                var response = await options.api.requestJson('/operations/preview', {method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({operation: {kind: 'preprocess', column_ids: ['review-column'], rules: rules}, rows: rows})});
                if (expected !== version) return;
                if (!Array.isArray(response.rows) || response.rows.length !== rows.length || response.rows.some(function (row, i) {
                    return row.excel_row !== rows[i].excel_row || !Array.isArray(row.values) || row.values.length !== 1 || typeof row.values[0] !== 'string' || row.values[0].length > 32767;
                })) throw new Error('전처리 결과의 행이나 값이 올바르지 않아요. 다시 확인해 주세요.');
                var values = response.rows.map(function (row) { return row.values[0]; });
                var changed = values.filter(function (value, i) { return value !== rows[i].values[0]; }).length;
                pending = changed ? {target: selected, snapshot: snapshot, values: values} : null;
                status(column.label + ' · 전체 ' + rows.length + '행 중 ' + changed + '행 변경 예정. 아래는 앞 10행이에요. 빈 필수값은 직접 채운 뒤 최종 반영하세요.');
                values.slice(0, 10).forEach(function (value, i) {
                    var line = document.createElement('p'); line.textContent = rows[i].excel_row + '행: ' + JSON.stringify(rows[i].values[0]) + ' → ' + JSON.stringify(value); el('examples').appendChild(line);
                });
            } catch (error) { if (expected === version) status(error.message); }
            finally { options.setBusy(false); updateControls(); }
        }
        async function apply() {
            if (options.isBusy() || !pending) return;
            var work = pending, expected = version; pending = null; options.setBusy(true);
            try {
                if (work.target.cid !== options.getConversationId()) throw new Error('대화가 바뀌었어요. 검토 표를 다시 열어 주세요.');
                await sheet.writePreprocess(work.target.cid, work.target.did, work.snapshot, work.values);
                if (expected !== version) return;
                var message = '검토 시트에 전처리를 적용했어요. 추가 수정도 가능해요. 최종 값은 ‘수정 내용 반영’을 눌러 조사 조건에 저장하세요.';
                status(message); document.getElementById('documents-status').textContent = message;
            } catch (error) { if (expected === version) status(error.message); }
            finally { options.setBusy(false); updateControls(); }
        }
        el('column').addEventListener('change', invalidate); el('words').addEventListener('input', invalidate);
        el('preview').addEventListener('click', preview); el('apply').addEventListener('click', apply);
        el('close').addEventListener('click', reset);
        return {open: open, reset: reset, updateControls: updateControls};
    };
})();
