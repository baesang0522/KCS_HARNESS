"use strict";
(function () {
    function columnName(index) {
        var result = "";
        for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
            result = String.fromCharCode(65 + (n - 1) % 26) + result;
        }
        return result;
    }
    function literal(value) {
        return typeof value === "string" && value ? "'" + value : value;
    }
    async function write(snapshot, data, settings, capturedAt, requestId, progress) {
        var sourceRows = new Map(snapshot.rows.map(function (row) { return [row.excel_row, row]; }));
        if (!Array.isArray(data.rows) || data.rows.length > 50000 || data.rows.length !== data.pair_count || data.rows.some(function (item) {
            var a = sourceRows.get(item.base_row), b = sourceRows.get(item.candidate_row);
            return !a || !b || a.values[0] !== item.base || b.values[0] !== item.candidate ||
                !Number.isFinite(item.score) || item.score < 0 || item.score > 100 ||
                !Number.isInteger(item.base_count) || item.base_count < 1 ||
                !Number.isInteger(item.candidate_count) || item.candidate_count < 1 ||
                (settings.group_column_id && (a.values[1] !== item.group || b.values[1] !== item.group));
        })) throw new Error("유사도 결과의 값이나 원본 위치가 올바르지 않습니다.");
        var name = "유사도_" + requestId.replace(/-/g, "").slice(0, 12);
        return Excel.run(async function (context) {
            var sheet = null;
            try {
                sheet = context.workbook.worksheets.add(name + "_작성중");
                await context.sync();
                var metadata = [
                    ["검사 대상", snapshot.workspace.sheet_name + " / " + snapshot.columns[0].header],
                    ["검사 범위", (snapshot.row_start + 1) + "~" + (snapshot.row_start + snapshot.rows.length) + "행 (숨긴 행 포함)"],
                    ["비교 방식", settings.method === "sequence" ? "SequenceMatcher (양방향 평균)" : "Levenshtein"],
                    ["표시 기준", "모든 비교 쌍. 점수는 결과 표 머리글에서 정렬·필터하세요."],
                    ["비교 조건", settings.group_column_id ? snapshot.columns[1].header + " 값이 같은 행끼리" : "없음"],
                    ["데이터 읽기 완료 시각", capturedAt],
                    ["검사 요약", "입력 " + data.input_rows + "행 / 제외 " + data.skipped_rows + "행 / 조건별 고유값 " + data.unique_values + "개 / 비교 " + data.pair_count + "쌍"],
                    ["결과 요약", "전체 비교 결과 " + data.rows.length + "쌍 (생략 없음)"],
                    ["주의", "검사 당시 값입니다. 이후 원본을 수정해도 이 결과는 자동 갱신되지 않습니다. 자동 통합하지 않습니다."]
                ];
                var metaRange = sheet.getRangeByIndexes(0, 0, metadata.length, 2);
                metaRange.numberFormat = metadata.map(function (row) { return row.map(function (v) { return typeof v === "number" ? "0.00" : "@"; }); });
                metaRange.values = metadata.map(function (row) { return row.map(literal); });
                var headers = ["기준값", "기준값 건수", "비교 후보", "비교 후보 건수", "유사도 점수"];
                if (settings.group_column_id) headers.push("비교 조건");
                sheet.getRangeByIndexes(10, 0, 1, headers.length).values = [headers];
                for (var offset = 0; offset < data.rows.length; offset += 100) {
                    var part = data.rows.slice(offset, offset + 100);
                    var values = part.map(function (item) {
                        var row = [item.base, item.base_count, item.candidate, item.candidate_count, item.score];
                        if (settings.group_column_id) row.push(item.group);
                        return row;
                    });
                    var range = sheet.getRangeByIndexes(11 + offset, 0, part.length, headers.length);
                    range.numberFormat = values.map(function (row) { return row.map(function (v, i) { return typeof v === "string" ? "@" : i === 4 ? "0.00" : "0"; }); });
                    range.values = values.map(function (row) { return row.map(literal); });

                    await context.sync();
                    progress("결과 시트 작성", offset + part.length, data.rows.length);
                }
                if (data.rows.length) {
                    sheet.tables.add(sheet.getRangeByIndexes(10, 0, data.rows.length + 1, headers.length), true);
                }
                var used = sheet.getRangeByIndexes(0, 0, 11 + data.rows.length, headers.length);
                used.format.columnWidth = 120;
                used.format.wrapText = true;
                sheet.getRange("A:A").format.columnWidth = 180;
                sheet.getRange("C:C").format.columnWidth = 180;
                sheet.freezePanes.freezeRows(11);
                sheet.name = name;
                sheet.activate();
                sheet.getRange("A11").select();
                await context.sync();
                return name;
            } catch (error) {
                throw new Error("결과 시트 작성에 실패했습니다. ‘" + name + "’ 또는 같은 이름의 ‘작성중’ 시트가 남아 있을 수 있습니다. 원본은 수정하지 않았습니다. " + error.message);
            }
        });
    }
    window.similaritySheet = {write: write};
})();
