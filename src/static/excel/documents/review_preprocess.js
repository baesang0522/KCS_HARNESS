"use strict";
(function () {
    window.createReviewPreprocess = function (options) {
        var sheet = options.sheet || window.investigationSheet, version = 0;
        return {
            reset: function () { version++; }, updateControls: function () {},
            run: async function (action) {
                if (options.isBusy()) return;
                var expected = ++version, cid = options.getConversationId(), did = action.document_id;
                options.setBusy(true);
                try {
                    var columns = await sheet.preprocessTargets(cid, did);
                    var candidates = columns.filter(function (c) { return c.kind === action.kind && c.label.split(' · ').pop() === action.column; });
                    if (candidates.length !== 1) throw new Error('검토 시트의 열을 확인해 줘: ' + columns.map(function (c) { return c.label; }).join(', '));
                    var snapshot = await sheet.readPreprocess(cid, did, candidates[0]);
                    var rows = snapshot.values.map(function (r, i) { return {excel_row: snapshot.row_start + i + 1, values: [String(r[snapshot.column_index])]}; });
                    var response = await options.api.requestJson('/operations/preview', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation: {kind: 'preprocess', column_ids: ['review-column'], rules: action.rules}, rows: rows})});
                    if (version !== expected || cid !== options.getConversationId()) return;
                    if (!Array.isArray(response.rows) || response.rows.length !== rows.length || response.rows.some(function (r, i) { return r.excel_row !== rows[i].excel_row || !Array.isArray(r.values) || r.values.length !== 1 || typeof r.values[0] !== 'string' || r.values[0].length > 32767; })) throw new Error('전처리 결과가 요청한 행과 다릅니다.');
                    var values = response.rows.map(function (r) { return r.values[0]; }), changed = values.filter(function (v, i) { return v !== rows[i].values[0]; }).length;
                    if (!changed) { options.messages.say('검토 시트 ' + rows.length + '행을 확인했어. 바뀔 값이 없어.'); return; }
                    options.messages.confirm('PDF 검토 시트 ‘' + candidates[0].label + '’ ' + rows.length + '행 중 ' + changed + '행이 변경될 예정이야.\n적용 후 조사 조건에 반영하려면 ‘PDF 수정 내용 반영’이라고 요청해 줘.', {apply: async function () {
                        if (version !== expected || cid !== options.getConversationId()) throw new Error('조사가 바뀌었어. 다시 요청해 줘.');
                        options.setBusy(true);
                        try { await sheet.writePreprocess(cid, did, snapshot, values); options.messages.say('완료했어. PDF 검토 시트의 ' + changed + '행을 변경했어. 조사 조건 반영은 아직이야.'); }
                        finally { options.setBusy(false); }
                    }, cancel: function () { version++; options.messages.say('검토 시트 전처리를 취소했어.'); }}, ['Excel 행', '이전 값', '변경 예정 값'], rows.map(function (r, i) { return [r.excel_row, r.values[0], values[i]]; }));
                } finally { options.setBusy(false); }
            }
        };
    };
})();
