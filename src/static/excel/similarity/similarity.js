"use strict";
(function () {
    window.createSimilarityController = function (options) {
        async function run(settings) {
            if (options.isBusy()) return;
            options.setBusy(true);
            var progress = function (label, done, total) { options.status(label + ' · ' + done + '/' + total); };
            try {
                if (!['levenshtein', 'sequence'].includes(settings.method)) throw new Error('비교 방식을 알려주세요: 철자 차이 또는 공통 문자열.');
                var current = await options.getInput(), ids = [settings.column_id].concat(settings.group_column_id ? [settings.group_column_id] : []);
                var snapshot = await window.operationsSheet.read(current.workspace, current.target, ids, progress, function () {});
                var result = await options.api.requestJson('/operations/similarity', {method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({settings: settings, rows: snapshot.rows.map(function (row) { return {excel_row: row.excel_row, value: row.values[0], group: settings.group_column_id ? row.values[1] : ''}; })})});
                async function verify() {
                    var latest = await options.getInput();
                    var next = await window.operationsSheet.read(latest.workspace, latest.target, ids, progress, function () {});
                    if (snapshot.stamp !== next.stamp || JSON.stringify(snapshot.rows) !== JSON.stringify(next.rows)) throw new Error('비교 중 데이터나 작업 범위가 바뀌었어. 다시 요청해 줘.');
                }
                await verify();
                var text = snapshot.rows.length.toLocaleString() + '행에서 ' + result.rows.length.toLocaleString() + '쌍을 ' + (settings.method === 'levenshtein' ? '철자 차이' : '공통 문자열') + ' 방식으로 비교했어. 셀은 변경하지 않았어. 점수는 같은 기업이라는 확정 판단이 아니야.';
                var headers = ['기준값', '비교값', '점수', '기준 건수', '비교 건수', '그룹', '기준 첫 행', '비교 첫 행'];
                var rows = result.rows.map(function (r) { return [r.base, r.candidate, r.score, r.base_count, r.candidate_count, r.group, r.base_row, r.candidate_row]; });
                if (settings.result_sheet) {
                    options.messages.confirm(text + '\n적용하면 비교 결과를 새 시트에 저장할게.', {apply: async function () {
                        options.setBusy(true);
                        try { await verify(); var name = await window.similaritySheet.write(snapshot, result, settings, new Date().toISOString(), options.api.newRequestId(), progress); options.complete('완료했어. ‘' + name + '’ 시트에 ' + rows.length + '쌍을 저장했어.'); }
                        finally { options.setBusy(false); }
                    }, cancel: function () { options.messages.say('결과 시트 만들기를 취소했어.'); }}, headers, rows);
                } else options.messages.table(options.messages.say(text), headers, rows);
            } finally { options.setBusy(false); }
        }
        return {run: run, reset: function () {}, busy: function () {}};
    };
})();
