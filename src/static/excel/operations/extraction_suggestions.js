"use strict";
(function () {
    window.readExtractionSuggestions = async function (workspace, target, ids, api, progress) {
        if (ids.length !== 1) throw new Error("추천할 열 하나를 선택하세요.");
        var models = workspace.columns.filter(function (column) { return column.role === "model_spec"; });
        if (workspace.task_type !== "model_normalization" || models.length !== 1 || String(models[0].column_id) !== ids[0]) {
            throw new Error(window.errorMessages.MODEL_SPEC_REQUIRED);
        }

        var snapshot = await window.operationsSheet.read(
            workspace, target, ids, progress, function () {}
        );
        var rows = snapshot.rows;
        if (!rows.length) throw new Error("추천할 데이터가 없습니다.");

        var summary = {sample_count: 0, suggestions: []};

        for (var offset = 0; offset < rows.length;) {
            var values = [], characters = 0;
            while (offset < rows.length && values.length < 10000) {
                var value = rows[offset].values[0];
                if (value.length > 32767) throw new Error("셀 문자열이 너무 깁니다.");
                if (characters + value.length > 16000000) break;

                values.push(value);
                characters += value.length;
                offset += 1;
            }

            var data = await api.requestJson("/operations/extraction-suggestions", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({values: values})
            });

            summary.sample_count += data.sample_count;
            data.suggestions.forEach(function (item) {
                var total = summary.suggestions.find(function (entry) {
                    return entry.mode === item.mode;
                });
                if (!total) {
                    summary.suggestions.push(item);
                    return;
                }
                total.matched_rows += item.matched_rows;
                total.multiple_rows += item.multiple_rows;
                total.examples = total.examples.concat(item.examples).slice(0, 2);
            });

            progress("패턴 검사", offset, rows.length);
        }

        return summary;
    };
})();
