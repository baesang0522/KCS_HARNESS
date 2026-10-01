"use strict";

(function () {
    window.createNormalizationTransform = function (options) {
        var ui = window.createNormalizationTransformUI();
        var sheet = window.normalizationTransformSheet;
        var workspace = null;
        var target = null;
        var preview = null;
        var processing = false;
        var cancelled = false;
        var abort = null;

        function checkCancelled() {
            if (cancelled) throw new Error("처리를 취소했습니다. 시트는 변경하지 않았습니다.");
        }

        function invalidate() {
            preview = null;
            ui.clearPreview();
        }

        function progress(phase, done, total) {
            options.setStatus(phase + " 중 · " + done.toLocaleString() + " / " +
                total.toLocaleString() + "행. 완료 전에는 시트 편집·정렬을 기다려 주세요.");
        }

        async function buildPreview() {
            if (options.isBusy() || !target) return;
            try {
                var rules = ui.rules();
                var column = target.columns.find(function (item) {
                    return String(item.column_id) === ui.columnId();
                });
                if (!column) throw new Error("작업 표에서 처리할 열을 다시 선택하세요.");
                invalidate();
                processing = true;
                cancelled = false;
                abort = new AbortController();
                options.setBusy(true);
                var snapshot = await sheet.read(workspace, target, column, function (done, total) {
                    progress("현재 값 읽기", done, total);
                }, checkCancelled);
                var values = [];
                var changed = 0;
                // ponytail: 전체 결과는 현재 창 메모리에 보관한다. 대용량 실측 후 시트 임시 저장을 검토한다.
                for (var offset = 0; offset < snapshot.rows.length; offset += 1000) {
                    checkCancelled();
                    var rows = snapshot.rows.slice(offset, offset + 1000).map(function (row) {
                        return {excel_row: row.excel_row, value: row.value};
                    });
                    var result = await options.api.requestJson("/jobs/model-normalization/transform", {
                        method: "POST", headers: {"Content-Type": "application/json"},
                        signal: abort.signal,
                        body: JSON.stringify({worksheet_id: workspace.worksheet_id,
                            column_index: snapshot.column.column_index, rows: rows,
                            rule_set: {rules: rules}})
                    });
                    checkCancelled();
                    if (result.worksheet_id !== workspace.worksheet_id ||
                        result.column_index !== snapshot.column.column_index ||
                        !Array.isArray(result.rows) || result.rows.length !== rows.length) {
                        throw new Error("처리 결과의 범위가 요청과 다릅니다. 다시 확인하세요.");
                    }
                    result.rows.forEach(function (row, index) {
                        if (row.excel_row !== rows[index].excel_row || typeof row.value !== "string" ||
                            row.value.length > 32767) throw new Error("유효하지 않은 행 처리 결과입니다.");
                        values.push(row.value);
                        if (row.value !== rows[index].value) changed += 1;
                    });
                    progress("전처리·치환", values.length, snapshot.rows.length);
                }
                preview = {snapshot: snapshot, values: values, changed: changed};
                ui.showPreview(preview);
                options.setStatus("변경 내용과 결과 위치를 확인하세요. 새 결과 열을 만든 뒤 직접 수정할 수 있습니다.");
            } catch (error) {
                invalidate();
                options.setStatus(cancelled ? "처리를 취소했습니다. 시트는 변경하지 않았습니다." : error.message);
            } finally {
                processing = false;
                abort = null;
                options.setBusy(false);
            }
        }

        async function apply() {
            if (options.isBusy() || !preview) return;
            var data = preview;
            try {
                var output = ui.output();
                options.setBusy(true);
                var column = await sheet.write(data.snapshot, data.values, output, progress);
                invalidate();
                workspace.columns.push(column);
                // 새 결과 열을 다음 연산의 입력으로 바로 연결한다.
                target = {worksheet_id: workspace.worksheet_id, sheet_name: column.sheet_name,
                    address: column.address, row_start: data.snapshot.row_start,
                    row_count: data.values.length, column_count: 1, columns: [column]};
                options.onResult(workspace, target);
                options.setStatus("‘" + column.header + "’ 열에 " + data.values.length.toLocaleString() +
                    "행을 작성했습니다. 현재 작업 대상은 새 결과 열입니다.");
            } catch (error) {
                invalidate();
                options.setStatus(error.message);
            } finally {
                options.setBusy(false);
            }
        }

        ui.bind({
            change: invalidate,
            preview: buildPreview,
            apply: apply,
            cancel: function () { cancelled = true; if (abort) abort.abort(); },
            pick: async function () {
                if (options.isBusy() || !preview) return;
                options.setBusy(true);
                try {
                    ui.setAnchor(await sheet.pickAnchor(workspace));
                } catch (error) {
                    options.setStatus(error.message);
                } finally {
                    options.setBusy(false);
                }
            }
        });

        return {
            show: function (nextWorkspace, nextTarget) {
                workspace = nextWorkspace;
                target = nextTarget;
                invalidate();
                ui.show(target);
            },
            hide: function () { target = null; invalidate(); ui.hide(); },
            reset: function () { workspace = null; target = null; invalidate(); ui.reset(); },
            setBusy: function (busy) { ui.setBusy(busy, processing); }
        };
    };
})();
