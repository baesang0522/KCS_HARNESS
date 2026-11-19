"use strict";
(function () {
    window.createOperationsUI = function (messages) {
        var columns = [], selected = [], operation = null, output = null, handlers = {}, offer = null;
        function find(id) {
            var column = columns.find(function (c) { return String(c.column_id) === String(id); });
            if (!column) throw new Error('요청한 열이 삭제되었거나 작업표에 없습니다.');
            return column;
        }
        function clear() { if (offer) offer.disable(); offer = null; }
        function outputNames(data) {
            if (output.mode === 'existing') return [find(output.column_id).header];
            var names = ['group', 'extract'].includes(data.operation.kind) ? [output.name, output.name + (data.operation.kind === 'group' ? ' 변경여부' : ' 추출상태')] : data.names.map(function (_, i) { return output.name + (data.names.length > 1 ? ' ' + (i + 1) : ''); });
            return window.operationsSheet.uniqueNames(names, columns);
        }
        return {
            targets: function () { return selected.slice(); },
            pending: function () { return operation ? JSON.parse(JSON.stringify(operation)) : null; },
            forget: function () { clear(); operation = output = null; },
            reconcile: function (available, fallback) {
                columns = available;
                var missing = selected.concat(output && output.column_id || []).some(function (id) { return !columns.some(function (c) { return String(c.column_id) === String(id); }); });
                if (missing) { operation = output = null; selected = fallback.map(String); clear(); }
                return missing;
            },
            show: function (available, preferred) { columns = available; selected = preferred.map(String); operation = output = null; clear(); },
            configure: function (value) {
                clear(); operation = JSON.parse(JSON.stringify(value));
                selected = Array.from(new Set(value.column_ids.concat(value.kind === 'group' ? [value.value_column_id] : [])));
                selected.forEach(find);
                var source = find(value.kind === 'group' ? value.value_column_id : value.column_ids[0]);
                output = Object.assign({mode: 'new', anchor: String(source.column_id), side: 'after', name: source.header + ({split: value.part === 'last' ? ' 마지막 단어' : ' 단어', replace: ' 치환', map: ' 대표값', group: ' 통일', extract: ' 모델명 후보'}[value.kind] || ' 정제')}, Object.fromEntries(Object.entries(value.output || {}).filter(function (entry) { return entry[1] !== null; })));
                if (value.condition) {
                    if (value.output && (value.output.mode !== 'existing' || value.output.column_id !== value.destination_column_id)) throw new Error('조건부 변경의 저장 열이 일치하지 않습니다.');
                    output = {mode: 'existing', column_id: value.destination_column_id};
                }
                if (output.mode === 'existing') { output.name = find(output.column_id).header; delete output.anchor; }
                else { find(output.anchor); if (!output.name || !output.name.trim()) throw new Error('새 열 이름을 알려주세요.'); }
                operation.output = Object.assign({}, output);
            },
            operation: function () { return operation && JSON.parse(JSON.stringify(operation)); },
            destination: function () { return output && output.mode === 'existing' ? output.column_id : null; },
            output: function () { if (!output) throw new Error('저장할 위치가 없습니다. 작업을 다시 요청하세요.'); return Object.assign({}, output); },
            names: outputNames,
            preview: function (data) {
                var names = outputNames(data), existing = output.mode === 'existing', special = ['group', 'extract'].includes(data.operation.kind);
                var rows = data.values.map(function (values, i) {
                    var original = data.snapshot.rows[i], before = existing ? original.destination : original.values[data.operation.kind === 'group' ? original.values.length - 1 : 0];
                    var after = special || existing ? values.slice(0, 1) : values;
                    return {changed: after.length !== 1 || before !== after[0], blank: after.some(function (v) { return !String(v).trim(); }),
                        cells: [original.excel_row, before].concat(after).concat(special ? [values[1]] : [])};
                });
                rows.sort(function (a, b) { return Number(b.changed || b.blank) - Number(a.changed || a.blank); });
                var title = data.snapshot.columns.map(function (c) { return c.header; }).join(' · ');
                var text = title + ' ' + data.values.length.toLocaleString() + '행 중 ' + data.changed.toLocaleString() + '행이 변경될 예정이야.\n';
                text += existing ? '저장 위치: 작업표의 기존 열 ‘' + names[0] + '’\n' : '저장 위치: 새 열 ‘' + names.join('’, ‘') + '’ · ‘' + find(output.anchor).header + '’ ' + (output.side === 'before' ? '앞' : '뒤') + '\n';
                text += (data.operation.condition_scope === 'all' ? '작업표 전체에서 처리 · ' : '현재 작업 범위 안에서 처리 · ') + '작업 범위: ' + window.operationsSheet.describeFilter(data.snapshot.row_filter, columns) + '\n';
                if (data.operation.condition) text += '추가 조건: ' + window.operationsSheet.describeFilter(data.operation.condition, columns) + '\n';
                text += '빈 결과 ' + rows.filter(function (r) { return r.blank; }).length.toLocaleString() + '행. 아직 셀은 변경하지 않았어.';
                if (special) text += '\n' + ['변경', '유지', '확인 필요', '단일 후보', '미검출', '확인 필요 · 복수 후보'].map(function (status) { var count = data.values.filter(function (v) { return v[1] === status; }).length; return count ? status + ' ' + count + '행' : ''; }).filter(Boolean).join(' · ');
                rows.slice(0, 3).forEach(function (row) { text += '\n변경 예시 ' + row.cells[0] + '행: ' + JSON.stringify(row.cells[1]) + ' → ' + row.cells.slice(2, special ? -1 : undefined).map(function (v) { return JSON.stringify(v); }).join(' | '); });
                if (existing && special) text += '\n기존 열에는 결과값만 반영하고 상태 정보는 아래 결과에서 확인할 수 있어.';
                offer = messages.confirm(text, {apply: handlers.apply, cancel: async function () { await handlers.edit(); operation = output = null; }}, ['Excel 행', '이전 값'].concat(names.slice(0, existing ? 1 : special ? 1 : undefined)).concat(special ? ['상태'] : []), rows.map(function (r) { return r.cells; }));
            },
            extractionSuggestions: function (data) {
                var expected = operation;
                var message = messages.say('현재 대상 ' + data.sample_count.toLocaleString() + '행에서 추출 방식을 비교했어. 사용할 방식을 골라줘. 아직 셀은 변경하지 않았어.');
                data.suggestions.forEach(function (suggestion) {
                    var line = document.createElement('p'); line.textContent = suggestion.label + ' · 일치 ' + suggestion.matched_rows + '행 · 복수 후보 ' + suggestion.multiple_rows + '행'; message.appendChild(line);
                    messages.button(message, suggestion.label + ' 사용', async function () {
                        if (!operation || operation !== expected) throw new Error('작업이 바뀌었어. 다시 추출을 요청해 줘.');
                        operation.extraction_mode = suggestion.mode; await handlers.preview();
                    });
                });
            },
            finalReview: function (snapshot, blanks) { offer = messages.confirm(snapshot.rows.length + '행의 현재 결과를 최종 기록으로 남길까? 빈 셀은 ' + blanks + '개야. 셀 값은 바꾸지 않아.', {apply: handlers['confirm-final'], cancel: handlers['cancel-final']}); },
            clear: clear, busy: function () { if (messages) messages.busy(); },
            bind: function (value) { handlers = value; }
        };
    };
})();
