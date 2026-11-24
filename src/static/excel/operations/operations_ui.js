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
            if (output.mode === 'existing') return [output.column_id].concat(output.score_column_id ? [output.score_column_id] : []).map(function (id) { return find(id).header; });
            if (data.operation.kind === 'dimensions') return window.operationsSheet.uniqueNames(data.names.map(function (name) { return output.name === '규격' ? name : output.name + ' ' + name; }), columns);
            if (data.operation.extraction_mode === 'pdf') return window.operationsSheet.uniqueNames([output.name, output.name + ' 종류'], columns);
            var names = ['group', 'extract', 'match_suppliers'].includes(data.operation.kind) ? [output.name, output.name + (data.operation.kind === 'group' ? ' 변경여부' : data.operation.kind === 'match_suppliers' ? ' 유사도 점수' : ' 추출상태')] : data.names.map(function (_, i) { return output.name + (data.names.length > 1 ? ' ' + (i + 1) : ''); });
            return window.operationsSheet.uniqueNames(names, columns);
        }
        return {
            targets: function () { return selected.slice(); },
            pending: function () { return operation ? JSON.parse(JSON.stringify(operation)) : null; },
            forget: function () { clear(); operation = output = null; },
            reconcile: function (available, fallback) {
                columns = available;
                var missing = selected.concat(output && output.column_id || [], output && output.score_column_id || []).some(function (id) { return !columns.some(function (c) { return String(c.column_id) === String(id); }); });
                if (missing) { operation = output = null; selected = fallback.map(String); clear(); }
                return missing;
            },
            show: function (available, preferred) { columns = available; selected = preferred.map(String); operation = output = null; clear(); },
            configure: function (value) {
                clear(); operation = JSON.parse(JSON.stringify(value)); value = operation;
                selected = Array.from(new Set(value.column_ids.concat(value.kind === 'group' ? [value.value_column_id] : [])));
                selected.forEach(find);
                var source = find(value.kind === 'group' ? value.value_column_id : value.column_ids[0]);
                if (value.kind === 'match_suppliers' && !value.output) {
                    var previous = columns.find(function (column) { return column.header === source.header + ' 그룹'; });
                    if (previous) value.output = {mode: 'existing', column_id: String(previous.column_id)};
                }
                output = Object.assign({mode: 'new', anchor: String(source.column_id), side: 'after', name: value.kind === 'dimensions' ? '규격' : value.extraction_mode === 'pdf' ? '모델명' : source.header + ({split: value.part === 'last' ? ' 마지막 단어' : ' 단어', replace: ' 치환', map: ' 대표값', match_suppliers: ' 그룹', group: ' 통일', extract: ' 모델명 후보'}[value.kind] || ' 정제')}, Object.fromEntries(Object.entries(value.output || {}).filter(function (entry) { return entry[1] !== null; })));
                if (value.kind === 'dimensions' && !value.condition_scope) value.condition_scope = 'all';
                if (value.condition && !["match_suppliers", "dimensions"].includes(value.kind)) {
                    if (value.output && (value.output.mode !== 'existing' || value.output.column_id !== value.destination_column_id)) throw new Error('조건부 변경의 저장 열이 일치하지 않습니다.');
                    output = {mode: 'existing', column_id: value.destination_column_id};
                }
                if (value.kind === 'dimensions' && output.mode === 'existing') {
                    if (!value.dimensions.fields || value.dimensions.fields.length !== 1) throw new Error('기존 열에는 추출할 치수 항목 하나를 지정해 줘.');
                    if (value.column_ids.includes(output.column_id) || value.condition && value.condition.column_id === output.column_id) throw new Error('치수 결과 열은 원본·조건 열과 달라야 해.');
                }
                if (value.extraction_mode === 'pdf' && output.mode === 'existing') throw new Error('모델명과 종류를 함께 저장할 새 결과 열로 요청해 줘.');
                if (output.mode === 'existing') { output.name = find(output.column_id).header; delete output.anchor; }
                else { find(output.anchor); if (!output.name || !output.name.trim()) throw new Error('새 열 이름을 알려주세요.'); }
                if (value.kind === 'match_suppliers' && output.mode === 'existing') {
                    var score = columns.find(function (column) { return column.header === find(output.column_id).header + ' 유사도 점수'; });
                    if (!output.score_column_id && score) output.score_column_id = String(score.column_id);
                    if (output.column_id === String(source.column_id) || output.score_column_id === String(source.column_id) || output.score_column_id === output.column_id) throw new Error('원본과 그룹·점수 결과 열은 서로 달라야 해.');
                    if (output.score_column_id) find(output.score_column_id);
                    operation.condition = {column_id: output.column_id, operator: 'blank', value: ''};
                }
                operation.output = Object.assign({}, output);
            },
            operation: function () { return operation && JSON.parse(JSON.stringify(operation)); },
            destination: function () { return output && output.mode === 'existing' ? (output.score_column_id ? [output.column_id, output.score_column_id] : output.column_id) : null; },
            output: function () { if (!output) throw new Error('저장할 위치가 없습니다. 작업을 다시 요청하세요.'); return Object.assign({}, output); },
            names: outputNames,
            preview: function (data) {
                var names = outputNames(data), existing = output.mode === 'existing', special = ['group', 'extract', 'match_suppliers'].includes(data.operation.kind) && data.operation.extraction_mode !== 'pdf';
                var matching = data.operation.kind === 'match_suppliers', pdf = data.operation.extraction_mode === 'pdf', dimensions = data.operation.kind === 'dimensions';
                var rows = data.values.map(function (values, i) {
                    var original = data.snapshot.rows[i], before = existing ? original.destination : original.values[data.operation.kind === 'group' ? original.values.length - 1 : 0];
                    var after = special || existing ? values.slice(0, 1) : values;
                    return {changed: dimensions ? values.slice(0, -1).some(Boolean) : pdf ? Boolean(values[0]) : after.length !== 1 || before !== after[0], blank: dimensions ? values.slice(0, -1).some(function (v) { return !v; }) : pdf ? !values[0] : after.some(function (v) { return !String(v).trim(); }),
                        source: original.values[0], group: values[0],
                        cells: [original.excel_row].concat(matching && existing ? [original.values[0]] : []).concat([before]).concat(dimensions ? [data.extracted_texts[i]] : []).concat(after).concat(special || dimensions && existing ? [values[values.length - 1]] : [])};
                });
                rows.sort(function (a, b) { return Number(b.changed || b.blank) - Number(a.changed || a.blank); });
                var title = data.snapshot.columns.map(function (c) { return c.header; }).join(' · ');
                var text = title + ' ' + data.values.length.toLocaleString() + '행 중 ' + data.changed.toLocaleString() + '행이 변경될 예정이야.\n';
                text += existing ? '저장 위치: 작업표의 기존 열 ‘' + names.join('’, ‘') + '’\n' : '저장 위치: 새 열 ‘' + names.join('’, ‘') + '’ · ‘' + find(output.anchor).header + '’ ' + (output.side === 'before' ? '앞' : '뒤') + '\n';
                text += (data.operation.condition_scope === 'all' ? '작업표 전체에서 처리 · ' : '현재 작업 범위 안에서 처리 · ') + '작업 범위: ' + window.operationsSheet.describeFilter(data.snapshot.row_filter, columns) + '\n';
                if (data.operation.condition) text += '추가 조건: ' + window.operationsSheet.describeFilter(data.operation.condition, columns) + '\n';
                if (matching) text += (data.operation.similarity_method === 'sequence' ? 'SequenceMatcher(양방향 평균)' : data.operation.similarity_method === 'levenshtein' ? 'Levenshtein' : '자동 매칭') + ' 방식 · 기준 거래처 ' + data.job.supplier_references.length + '개 × 고유 거래처 ' + data.unique_count.toLocaleString() + '개 비교. 최고 점수 ' + (data.operation.similarity_threshold ?? 90) + ' 이상만 반영 · 동점은 기준 목록 뒤 항목 · 대소문자·연속 공백 통일.\n' + (existing ? '그룹이 빈 행만 비교했어. 기존 그룹·점수는 유지하고, ' + (data.operation.similarity_threshold ?? 90) + ' 이상인 행만 채워.\n' : (data.operation.similarity_threshold ?? 90) + ' 미만·빈 거래처의 그룹명은 빈칸으로 남겨.\n');
                if (dimensions) text += data.parsing_summary + '\n확인 필요 ' + data.values.filter(function (v) { return v[v.length - 1].startsWith('확인 필요'); }).length + '행 · 미검출 ' + data.values.filter(function (v) { return v[v.length - 1] === '미검출'; }).length + '행.\n';
                if (pdf) text += 'PDF 모델명과 대소문자·연속 공백을 통일해 대조했어. 종류는 PDF 분류 그대로이고, 미검출은 빈칸이야.\n일치 후보 중 대소문자·연속 공백을 통일한 이름이 가장 긴 모델만 추출해. 최장 길이가 같거나 같은 모델에 분류가 여러 개면 두 열을 같은 순서로 줄바꿈해 표시해. 복수 후보 ' + data.values.filter(function (v) { return v[0].includes('\n'); }).length + '행. 두께 등 추가 조건의 충족 여부는 판정하지 않아.\n';
                text += '빈 결과 ' + rows.filter(function (r) { return r.blank; }).length.toLocaleString() + '행. 아직 셀은 변경하지 않았어.';
                if (special && !matching) text += '\n' + ['변경', '유지', '확인 필요', '단일 후보', '미검출', '확인 필요 · 복수 후보'].map(function (status) { var count = data.values.filter(function (v) { return v[1] === status; }).length; return count ? status + ' ' + count + '행' : ''; }).filter(Boolean).join(' · ');
                rows.slice(0, 3).forEach(function (row) { text += '\n변경 예시 ' + row.cells[0] + '행: ' + (matching ? JSON.stringify(row.source) + ' → ' + JSON.stringify(row.group) : JSON.stringify(row.cells[1]) + ' → ' + row.cells.slice(2, special ? -1 : undefined).map(function (v) { return JSON.stringify(v); }).join(' | ')); });
                if (existing && (special || dimensions) && !output.score_column_id) text += '\n기존 열에는 결과값만 반영하고 ' + (matching ? '점수' : '상태 정보') + '는 아래 결과에서 확인할 수 있어.';
                if (matching) {
                    var seen = new Set();
                    rows = rows.filter(function (row) {
                        var key = JSON.stringify(row.cells.slice(1));
                        if (seen.has(key)) return false;
                        seen.add(key); return true;
                    });
                    text += '\n아래 표는 같은 입력·결과를 한 번씩 보여줘. 적용하면 해당 거래처의 대상 행 모두에 반영해.';
                }
                offer = messages.confirm(text, {apply: handlers.apply, cancel: async function () { await handlers.edit(); operation = output = null; }}, ['Excel 행'].concat(matching && existing ? ['거래처', '이전 그룹'] : ['이전 값']).concat(dimensions ? ['찾은 치수 표기'] : []).concat(names.slice(0, existing ? 1 : special ? 1 : undefined)).concat(special || dimensions && existing ? [matching ? '유사도 점수' : '상태'] : []), rows.map(function (r) { return r.cells; }));
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
