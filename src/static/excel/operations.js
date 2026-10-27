"use strict";
(function () {
    window.createOperations = function (options) {
        var ui = window.createOperationsUI(), sheet = window.operationsSheet;
        var workspace = null, target = null, preview = null, processing = false, cancelled = false, abort = null;
        var finalSnapshot = null;
        function invalidate() { preview = finalSnapshot = null; ui.clear(); }
        function complete(text) { invalidate(); options.complete(text); }
        async function sampleRows() {
            if (!workspace || !target) return [];
            if (!ui.targets().length) return [];
            var snapshot = await sheet.read(workspace, Object.assign({}, target, {row_count: Math.min(10, target.row_count)}),
                ui.targets(), function () {}, function () {});
            return snapshot.rows;
        }
        async function loadValues() {
            if (options.isBusy() || !target) return;
            options.setBusy(true);
            try {
                if (await options.refresh()) { options.status("삭제된 대상 열을 제외했습니다. 처리할 열을 확인하고 다시 불러오세요."); return; }
                var snapshot = await sheet.read(workspace, target, ui.targets(), progress, function () {});
                var data = await options.api.requestJson("/operations/values", {method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({values: snapshot.rows.map(function (row) { return row.values[0]; })})});
                ui.catalog(data); options.status("현재 데이터의 그룹을 불러왔습니다. 빈 값 " + data.blank_count + "행은 제외했습니다.");
            } catch (error) { options.status(error.message); }
            finally { options.setBusy(false); }
        }
        function check() { if (cancelled) throw new Error("처리를 취소했습니다. 시트는 변경하지 않았습니다."); }
        function progress(phase, done, total) { options.status(phase + " · " + done.toLocaleString() + "/" + total.toLocaleString() + "행. 완료 전에는 편집·정렬을 기다려 주세요."); }
        async function build() {
            if (options.isBusy() || !target) return;
            options.setBusy(true);
            try {
                if (await options.refresh()) { complete("삭제된 대상 열을 제외했습니다. 작업 화면에서 다음 처리할 열을 선택하세요."); return; }
                var operation = ui.operation(); invalidate(); processing = true; cancelled = false;
                if (!operation) { complete("선택한 전처리 규칙이 없어 변경 없이 작업을 마쳤습니다."); return; }
                abort = new AbortController(); options.setBusy(true);
                var ids = operation.column_ids.concat(operation.kind === "group" ? [operation.value_column_id] : []);
                var snapshot = await sheet.read(workspace, target, ids, progress, check);
                var values = [], changed = 0, headers = [];
                var size = operation.kind === "group" ? snapshot.rows.length : 10000;
                // ponytail: 미리보기는 창 메모리에 보관. 200만 결과 셀을 넘으면 범위를 줄인다.
                for (var offset = 0; offset < snapshot.rows.length; offset += size) {
                    check();
                    var rows = snapshot.rows.slice(offset, offset + size).map(function (row) { return {excel_row: row.excel_row, values: row.values}; });
                    var result = await options.api.requestJson("/operations/preview", {
                        method: "POST", headers: {"Content-Type": "application/json"}, signal: abort.signal,
                        body: JSON.stringify({operation: operation, rows: rows})
                    });
                    check();
                    if (!Array.isArray(result.rows) || result.rows.length !== rows.length || !result.headers.length) throw new Error("결과 행 수가 요청과 다릅니다.");
                    result.rows.forEach(function (row, i) {
                        if (row.excel_row !== rows[i].excel_row || !Array.isArray(row.values) || row.values.some(function (v) { return typeof v !== "string" || v.length > 32767; })) throw new Error("유효하지 않은 처리 결과입니다.");
                        values.push(row.values);
                    });
                    if (result.headers.length > headers.length) headers = result.headers;
                    changed += result.changed_count;
                    if (headers.length * snapshot.rows.length > 2000000) throw new Error("결과가 200만 셀을 초과합니다. 범위를 줄여 주세요.");
                    progress("처리", values.length, snapshot.rows.length);
                }
                values.forEach(function (row) { while (row.length < headers.length) row.push(""); });
                if (!changed && operation.kind !== "group") {
                    complete(
                        snapshot.rows.length.toLocaleString() +
                        "행을 확인했습니다. 적용 조건에 따른 변경이 없어 작업을 마쳤습니다."
                    );
                    return;
                }
                preview = {operation: operation, snapshot: snapshot, values: values, names: headers, changed: changed};
                ui.preview(preview); options.status("변경 내용과 결과 위치를 확인하세요. 원본 열은 유지합니다.");
            } catch (error) {
                console.error("[operations.build]", error);
                complete(
                    "작업 미리보기 오류\n" +
                    (error.stack || error.message || String(error))
                );
            }
            finally { processing = false; abort = null; options.setBusy(false); }
        }
        function resultDescription(data, index) {
            var operation = data.operation;
            var sourceIndex = operation.kind === "group" ? data.snapshot.columns.length - 1 : 0;
            var source = data.snapshot.columns[sourceIndex];
            var previous = workspace.columns.find(function (column) {
                return String(column.column_id) === String(source.column_id);
            });
            var labels = {trim: "앞뒤 공백 제거", collapse_whitespace: "연속 공백 정리",
                normalize_fullwidth_ascii: "전각 ASCII 변환", uppercase: "대문자 통일",
                lowercase: "소문자 통일", remove_words: "지정 문자열 제거"};
            var action = "";
            if (operation.kind === "preprocess") {
                action = operation.rules.map(function (rule) {
                    return labels[rule.operation] + (rule.operation === "remove_words" ? " " + JSON.stringify(rule.words) : "");
                }).join(" → ");
            } else if (operation.kind === "split") {
                action = (operation.delimiter === null ? "공백" : JSON.stringify(operation.delimiter)) +
                    " 기준 분리 / " + (operation.part === "last" ? "마지막 단어" : (index + 1) + "번째 조각");
            } else if (operation.kind === "replace") {
                action = "문자열 치환 " + JSON.stringify(operation.find) + " → " + JSON.stringify(operation.replacement);
            } else if (operation.kind === "map") {
                action = "공백·대소문자 정리 기준 매핑 " + operation.mappings.length + "개 적용";
            } else if (operation.kind === "group") {
                var criteriaNames = data.snapshot.columns.slice(0, -1)
                    .map(function (column) { return column.header; })
                    .join(", ");

                action = "기준 열 " + criteriaNames;

                if (operation.group_mode === "first_non_empty") {
                    action +=
                        "의 정확히 같은 값끼리 그룹화 / " +
                        "그룹별 Excel 첫 번째 빈칸 아닌 값 적용";
                } else {
                    action +=
                        "의 공백·대소문자 정리 후 같은 값에 대표값 적용 / " +
                        "기준 행 " + operation.source_row;
                }

                if (index === 1) {
                    action +=
                        " / 변경여부: 변경·유지·확인 필요. " +
                        "확인 필요는 기준값 누락 또는 자동 대표값 없음";
                }
            }
            function short(value, max) { return value.length > max ? value.slice(0, max - 1) + "…" : value; }
            return "생성 원본: " + short(source.header, 180) +
                " / 생성 시 처리: " + short(action, 450) +
                " / 원본 설명: " + short(previous && previous.description || "미입력", 250);
        }
        async function apply() {
            if (options.isBusy() || !preview) return;
            var data = preview;
            try {
                var output = ui.output(); options.setBusy(true);
                var names = data.operation.kind === "group"
                    ? [output.name, output.name + " 변경여부"]
                    : data.names.map(function (_, i) {
                        return output.name +
                            (data.names.length > 1 ? " " + (i + 1) : "");
                    });
                // 쓰기 시작 후 같은 미리보기를 재사용하지 않는다.
                invalidate();
                var result = await sheet.write(data.snapshot, data.values, names, output, progress);
                result.columns.forEach(function (column, index) {
                    column.description = resultDescription(data, index);
                });
                await options.result(result);
                complete(result.row_count.toLocaleString() + "행의 결과를 작성했습니다. 새 결과 열에서 이어서 작업할 수 있습니다.");
            } catch (error) { complete(error.message); }
            finally { options.setBusy(false); }
        }
        async function finalize() {
            if (options.isBusy() || !target) return;
            options.setBusy(true); invalidate();
            try {
                if (await options.refresh()) { complete("삭제된 대상 열을 제외했습니다. 다음 처리할 열을 선택하세요."); return; }
                var snapshot = await sheet.read(workspace, target, ui.targets(), progress, function () {});
                var blanks = snapshot.rows.reduce(function (n, row) { return n + row.values.filter(function (v) { return !v.trim(); }).length; }, 0);
                finalSnapshot = snapshot; ui.finalReview(snapshot, blanks);
                options.status("대상 열과 행 수를 확인하고 결과를 확정하세요.");
            } catch (error) { complete(error.message); }
            finally { options.setBusy(false); }
        }
        async function confirmFinal() {
            if (options.isBusy() || !finalSnapshot) return;
            var snapshot = finalSnapshot;
            options.setBusy(true); invalidate();
            try {
                var current = await sheet.read(workspace, target, ui.targets(), progress, function () {});
                if (snapshot.stamp !== current.stamp || JSON.stringify(snapshot.rows) !== JSON.stringify(current.rows)) throw new Error("확인 중 값이 바뀌었습니다. 다시 확정하세요.");
                await options.finalized(snapshot.columns.map(function (c) { return c.column_id; }), snapshot.rows.length);
                complete("현재 결과를 확정했습니다. 원본은 유지되며 후속 작업도 계속할 수 있습니다.");
            } catch (error) { complete(error.message); }
            finally { options.setBusy(false); }
        }
        ui.bind({preview: build, apply: apply, finalize: finalize, status: options.status,
            "load-values": loadValues,
            change: function () { invalidate(); options.changed(); },
            "confirm-final": confirmFinal, "cancel-final": invalidate, edit: invalidate,
            cancel: function () { cancelled = true; if (abort) abort.abort(); }});
        return {
            reconcile: function (work, next, fallback) { workspace = work; target = next; invalidate(); return ui.reconcile(work.columns, fallback, work.task_type); },
            show: function (work, next, preferred, resetMode) { workspace = work; target = next; invalidate(); ui.show(work.columns, preferred || [], work.task_type, resetMode); },
            configure: function (operation) { invalidate(); ui.configure(operation); },
            sampleRows: sampleRows,
            targets: ui.targets,
            invalidate: invalidate,
            busy: function (busy) { ui.busy(busy, processing); },
            reset: function () { workspace = target = null; invalidate(); }
        };
    };
})();