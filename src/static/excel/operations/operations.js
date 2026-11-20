"use strict";
(function () {
    window.createOperations = function (options) {
        var ui = window.createOperationsUI(options.messages), sheet = window.operationsSheet;
        var workspace = null, target = null, preview = null, processing = false, cancelled = false, abort = null;
        var finalSnapshot = null, retirement = Promise.resolve(), originRequestId = null;
        function invalidate(keepJob) {
            var discarded = preview;

            preview = finalSnapshot = null;
            ui.clear();

            if (discarded && keepJob !== true) {
                retirement = options.jobs.status(discarded.job, "CANCELLED").then(function () { return null; }, function (error) { return error; });
            }
        }
        function complete(text, outcome) { invalidate(); ui.forget(); options.complete(text, outcome); }
        async function sampleRows() {
            if (!workspace || !target) return [];
            if (!ui.targets().length) return [];
            var snapshot = await sheet.read(workspace, target, ui.targets(), function () {}, function () {}, null, 10, null, null, true);
            return snapshot.rows;
        }
        async function recommendExtraction() {
            if (options.isBusy() || !target) return;
            options.setBusy(true);
            try {
                if (await options.refresh()) throw new Error("대상 열이 바뀌었습니다. 다시 선택하세요.");

                var summary = await window.readExtractionSuggestions(
                    workspace, target, ui.targets(), options.api, progress
                );
                ui.extractionSuggestions(summary);
                options.status("전체 대상의 추천을 확인하고 추출 방식을 선택하세요. 방식을 고르면 채팅에서 실제 변경 결과를 확인할 수 있습니다.");
            } catch (error) {
                options.status(error.message);
            } finally {
                options.setBusy(false);
            }
        }
        function check() { if (cancelled) throw new Error("처리를 취소했습니다. 시트는 변경하지 않았습니다."); }
        function progress(phase, done, total) { options.status(phase + " · " + done.toLocaleString() + "/" + total.toLocaleString() + "행. 완료 전에는 편집·정렬을 기다려 주세요."); }
        async function build(automatic, verify) {
            automatic = automatic === true;
            if (options.isBusy() || !target) return;
            options.setBusy(true);
            var job = null;
            try {
                if (await options.refresh()) { complete("삭제된 대상 열을 제외했습니다. 채팅으로 다음 처리할 열을 알려주세요."); return; }
                var operation = ui.operation(); invalidate(); processing = true; cancelled = false;
                var referenceComparison = operation && (operation.kind === "match_suppliers" || operation.extraction_mode === "pdf");
                if (automatic && (!operation || operation.kind !== "set" || !operation.condition ||
                    operation.condition.operator !== "equals" || operation.condition_scope !== "current" ||
                    !operation.destination_column_id || typeof verify !== "function")) {
                    throw new Error("대표 부호 연결만 바로 반영할 수 있습니다.");
                }
                if (!operation) { complete("선택한 전처리 규칙이 없어 변경 없이 작업을 마쳤습니다."); return; }
                var cancellationError = await retirement; if (cancellationError) throw cancellationError;
                abort = new AbortController();
                options.setBusy(true);

                var readWorkspace = workspace, readTarget = target;
                if (operation.kind === "set" && operation.condition && operation.condition_scope === "all") {
                    readWorkspace = Object.assign({}, workspace, {row_filter: null});
                    readTarget = await Excel.run(async function (context) {
                        var info = await window.workspaceTable.layout(context, workspace);
                        return {row_start: info.body.rowIndex, row_count: info.body.rowCount};
                    });
                }
                job = await options.jobs.create(
                    readWorkspace,
                    readTarget,
                    operation, originRequestId
                );
                check();
                var ids = operation.column_ids.concat(operation.kind === "group" ? [operation.value_column_id] : []);
                var destination = ui.destination ? ui.destination() : null;
                var snapshot = await sheet.read(readWorkspace, readTarget, ids, progress, check, destination, null, null, operation.condition, operation.kind === "match_suppliers");
                if (!snapshot.rows.length) {
                    await options.jobs.status(job, "NO_CHANGE");
                    complete(destination ? "현재 범위에 그룹이 빈 행이 없어. 기존 그룹과 점수는 그대로 유지했어." : "현재 작업 범위에 비교할 행이 없어. 셀은 변경하지 않았어.",
                        {kind: "operation", job_id: job.source.operation_job_id, status: "SUCCEEDED"});
                    return;
                }
                var values = [], changed = 0, headers = [];
                var comparisonRows = snapshot.rows;
                if (referenceComparison) {
                    var unique = new Map();
                    snapshot.rows.forEach(function (row) { if (!unique.has(row.values[0])) unique.set(row.values[0], row); });
                    comparisonRows = Array.from(unique.values());
                }
                var size = operation.kind === "group" ? snapshot.rows.length : referenceComparison ? 250 : 10000;
                // ponytail: 미리보기는 창 메모리에 보관. 200만 결과 셀을 넘으면 범위를 줄인다.
                for (var offset = 0; offset < comparisonRows.length; offset += size) {
                    check();
                    var rows = comparisonRows.slice(offset, offset + size).map(function (row) { return {excel_row: row.excel_row, values: row.values}; });
                    var result = await options.jobs.preview(
                        job,
                        rows,
                        abort.signal, snapshot.rows.length
                    );
                    check();
                    if (!Array.isArray(result.rows) || result.rows.length !== rows.length || !result.headers.length) throw new Error("결과 행 수가 요청과 다릅니다.");
                    result.rows.forEach(function (row, i) {
                        if (row.excel_row !== rows[i].excel_row || !Array.isArray(row.values) || row.values.some(function (v) { return typeof v !== "string" || v.length > 32767; })) throw new Error("유효하지 않은 처리 결과입니다.");
                        values.push(row.values);
                    });
                    if (result.headers.length > headers.length) headers = result.headers;
                    changed += result.changed_count;
                    if (headers.length * snapshot.rows.length > 2000000) throw new Error("결과가 200만 셀을 초과합니다. 범위를 줄여 주세요.");
                    progress(operation.kind === "match_suppliers" ? "고유 거래처 비교" : "처리", values.length, comparisonRows.length);
                }
                if (referenceComparison) {
                    var matches = new Map(comparisonRows.map(function (row, index) { return [row.values[0], values[index]]; }));
                    values = snapshot.rows.map(function (row) {
                        var result = matches.get(row.values[0]).slice();
                        if (destination && !result[0]) result[0] = row.destination;
                        return result;
                    });
                    changed = values.filter(function (row, index) { return operation.extraction_mode === "pdf" ? Boolean(row[0]) : row[0] !== snapshot.rows[index].values[0]; }).length;
                }
                values.forEach(function (row) { while (row.length < headers.length) row.push(""); });
                if (destination) changed = values.filter(function (row, i) { return row[0] !== snapshot.rows[i].destination; }).length;
                if (!changed && destination && !["group", "extract"].includes(operation.kind)) {
                    if (destination && options.reviewed && operation.kind !== "match_suppliers") {
                        var current = await sheet.read(readWorkspace, readTarget, ids, progress, check, destination, null, null, operation.condition);
                        if (current.stamp !== snapshot.stamp || JSON.stringify(current.rows) !== JSON.stringify(snapshot.rows) || JSON.stringify(current.scope_rows) !== JSON.stringify(snapshot.scope_rows)) throw new Error("확인 중 값이 바뀌었습니다. 다시 요청하세요.");
                        await options.reviewed(snapshot, destination);
                    }
                    await options.jobs.status(job, "NO_CHANGE");
                    complete(
                        snapshot.rows.length.toLocaleString() +
                        "행을 확인했습니다. 적용 조건에 따른 변경이 없어 작업을 마쳤습니다.",
                        {kind: "operation", job_id: job.source.operation_job_id, status: "SUCCEEDED"}
                    );
                    return;
                }
                await options.jobs.status(job, "PREVIEW_READY");
                check();
                preview = {
                    job: job,
                    operation: operation,
                    snapshot: snapshot,
                    values: values,
                    names: headers,
                    changed: changed,
                    unique_count: operation.kind === "match_suppliers" ? comparisonRows.filter(function (row) { return row.values[0].trim(); }).length : null
                };
                if (ui.output().mode === "existing" && operation.kind === "split" && headers.length !== 1) throw new Error("여러 열로 분리하는 결과는 새 열에 저장해야 해요. 새 열로 다시 요청해 주세요.");
                if (!automatic) { ui.preview(preview); options.status(operation.condition
                    ? "변경 내용을 확인하고 적용하세요. 조건을 바꾸려면 채팅으로 요청하세요."
                    : "변경 내용과 결과 위치를 확인하세요. 기존 열을 선택하면 해당 열의 대상 셀 값이 바뀝니다."); }
            } catch (error) {
                if (job) {
                    try {
                        await options.jobs.status(
                            job,
                            cancelled ? "CANCELLED" : "FAILED", null, error.message
                        );
                    } catch (recordError) {
                        error.message +=
                            " · 실행 상태 기록 실패: " +
                            recordError.message;
                    }
                }

                if (preview && preview.job === job) { preview = null; ui.clear(); }
                console.error("[operations.build]", error);

                complete(error.message || String(error), job && {kind: "operation", job_id: job.source.operation_job_id, status: "FAILED"});
            } finally {
                processing = false;
                abort = null;
                options.setBusy(false);
            }
            if (automatic && preview) await apply(verify, true);
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
                lowercase: "소문자 통일", remove_hangul: "한글 제거", remove_brackets: "괄호 기호 제거", remove_words: "지정 문자열 제거"};
            var action = "";
            if (operation.kind === "preprocess") {
                action = operation.rules.map(function (rule) {
                    return labels[rule.operation] + (rule.operation === "remove_words" ? " " + JSON.stringify(rule.words) : "");
                }).join(" → ");
            } else if (operation.kind === "set") {
                action = "지정값 입력 " + JSON.stringify(operation.assigned_value);
            } else if (operation.kind === "extract") {
                action = operation.extraction_mode === "pdf" ? "PDF 기준 모델명 대조 / 대소문자·연속 공백 통일 / 미검출은 빈칸 / 추가 조건 판정 아님" : operation.extraction_mode === "labelled" ? "MODEL·CODE·GRADE 뒤의 값 추출" : "문자·숫자 모델명 후보 추출";
                if (index === 1) action += operation.extraction_mode === "pdf" ? " / PDF 분류 그대로 / 모델명과 같은 순서" : " / 추출상태: 단일 후보·미검출·복수 후보";
            } else if (operation.kind === "split") {
                action = (operation.delimiter === null ? "공백" : JSON.stringify(operation.delimiter)) +
                    " 기준 분리 / " + (operation.part === "last" ? "마지막 단어" : (index + 1) + "번째 조각");
            } else if (operation.kind === "replace") {
                action = "문자열 치환 " + JSON.stringify(operation.find) + " → " + JSON.stringify(operation.replacement);
            } else if (operation.kind === "match_suppliers") {
                action = (operation.similarity_method === "sequence" ? "SequenceMatcher 양방향 평균" : operation.similarity_method === "levenshtein" ? "Levenshtein" : "자동 매칭: Levenshtein 후 미분류만 SequenceMatcher") + " / PDF 기준 거래처와 비교 / 최고 점수 90 이상 / 동점은 기준 목록 뒤 항목 / 공백·대소문자 통일";
                if (index === 1) action += " / 최고 유사도 점수";
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
        async function apply(verify, automatic) {
            if (options.isBusy() || !preview) return;

            var data = preview;
            var result = null;
            var recorded = false;
            var applyRequested = false;
            var writeStarted = false;

            try {
                options.setBusy(true);
                if (automatic) { check(); await verify(); check(); }
                if ((data.operation.kind === "match_suppliers" || data.operation.extraction_mode === "pdf") && options.beforeApply) await options.beforeApply();
                var output = ui.output();
                var writeValues = data.values, writeSnapshot = data.snapshot;
                if (output.mode === "existing") {
                    if (data.operation.kind === "split" && data.names.length !== 1) throw new Error("여러 열로 분리하는 결과는 새 열로 저장하세요.");
                    writeValues = data.values.map(function (row) { return output.score_column_id ? row.slice() : [row[0]]; });
                }
                options.setBusy(true);
                if (data.operation.kind === "match_suppliers" && output.mode === "existing") {
                    var current = await sheet.read(data.snapshot.workspace, data.snapshot.target, data.operation.column_ids,
                        progress, function () {}, data.snapshot.output_column_ids || output.column_id, null, null, data.operation.condition, true);
                    if (current.stamp !== data.snapshot.stamp || JSON.stringify(current.rows) !== JSON.stringify(data.snapshot.rows) ||
                        JSON.stringify(current.scope_rows) !== JSON.stringify(data.snapshot.scope_rows)) throw new Error("비교 후 데이터가 바뀌었습니다. 새 미리보기를 확인하세요.");
                    var matched = data.values.map(function (row, i) { return row[0].trim() && row[1] !== "" && Number(row[1]) >= 90 ? i : -1; }).filter(function (i) { return i >= 0; });
                    writeValues = matched.map(function (i) { return writeValues[i]; });
                    writeSnapshot = Object.assign({}, data.snapshot, {
                        rows: matched.map(function (i) { return data.snapshot.rows[i]; }),
                        scope_rows: matched.map(function (i) { return data.snapshot.scope_rows[i]; }),
                        identity_filter: matched.map(function (i) { return data.snapshot.rows[i].identity; })
                    });
                }

                var names = data.operation.extraction_mode === "pdf" ? [output.name, output.name + " 종류"] : ["group", "extract", "match_suppliers"].includes(data.operation.kind)
                    ? [output.name, output.name + (data.operation.kind === "group" ? " 변경여부" : data.operation.kind === "match_suppliers" ? " 유사도 점수" : " 추출상태")]
                    : data.names.map(function (_, i) {
                        return output.name +
                            (data.names.length > 1 ? " " + (i + 1) : "");
                    });

                if (output.mode === "existing") names = [output.column_id].concat(output.score_column_id ? [output.score_column_id] : []).map(function (id) { return data.snapshot.output_columns.find(function (c) { return String(c.column_id) === id; }).header; });
                var dependencyRecord = options.prepareResult ? await options.prepareResult(data.snapshot, output) : null;
                if (automatic) check();
                invalidate(true);
                applyRequested = true;
                await options.jobs.beginApply(data.job, output);

                writeStarted = true;
                result = await sheet.write(
                    writeSnapshot, writeValues, names, output, progress, null,
                    options.recovery ? function (context, info, outputs) { return options.recovery.operation(data.job, context, info, writeSnapshot, outputs, writeValues); } : null
                );

                if (options.recovery) options.recovery.remember(data.job.source.operation_job_id, function () { return options.result(result, data.job, data.snapshot, dependencyRecord); });
                await options.jobs.status(
                    data.job,
                    "APPLIED",
                    result.columns.map(function (column) {
                        return String(column.column_id);
                    })
                );
                recorded = true;
                result.columns.forEach(function (column, index) {
                    if (output.mode !== "existing") column.description = resultDescription(data, index);
                });
                await options.result(result, data.job, data.snapshot, dependencyRecord);
                if (options.recovery) options.recovery.completed(data.job.source.operation_job_id);

                complete(
                    "완료했어. " + (output.mode === "existing" ? "기존 열 ‘" : "새 열 ‘") + result.columns.map(function (column) { return column.header; }).join("’, ‘") + "’에 " + result.row_count.toLocaleString() + "행의 결과를 저장했어. 변경된 값은 " + data.changed.toLocaleString() + "행이야.",
                    {kind: "operation", job_id: data.job.source.operation_job_id, status: "SUCCEEDED"}
                );
            } catch (error) {
                if (!applyRequested) {
                    if (automatic) {
                        invalidate(true);
                        try { await options.jobs.status(data.job, cancelled ? "CANCELLED" : "FAILED", null, error.message); }
                        catch (recordError) { error.message += " · 실행 상태 기록 실패: " + recordError.message; }
                        complete(error.message, {kind: "operation", job_id: data.job.source.operation_job_id, status: "FAILED"});
                    } else options.status(error.message);
                    return;
                }

                var recordMessage = "";
                if (!recorded) {
                    try {
                        await options.jobs.status(data.job, "UNKNOWN", null, error.message);
                    } catch (recordError) {
                        console.warn("정제 적용 상태 기록 실패", recordError);
                        recordMessage = " · 서버 실행 상태를 확인하지 못했습니다.";
                    }
                }

                var message = result
                    ? "결과는 작성됐습니다. 다시 적용하지 마세요. "
                    : writeStarted
                        ? "결과가 일부 작성됐을 수 있습니다. 시트를 확인하세요. "
                        : "적용 시작을 확인하지 못해 Excel 쓰기를 진행하지 않았습니다. ";

                complete(message + error.message + recordMessage, {kind: "operation", job_id: data.job.source.operation_job_id, status: "UNKNOWN"});
            } finally {
                options.setBusy(false);
            }
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
                await options.finalized(snapshot.columns.map(function (c) { return c.column_id; }), snapshot.rows.length, snapshot);
                complete("현재 결과를 확정했습니다. 원본은 유지되며 후속 작업도 계속할 수 있습니다.");
            } catch (error) { complete(error.message); }
            finally { options.setBusy(false); }
        }
        ui.bind({preview: build, apply: apply, finalize: finalize, status: options.status,
            recommend: recommendExtraction,
            change: function () { invalidate(); options.changed(); },
            "confirm-final": confirmFinal, "cancel-final": invalidate, edit: async function () {
                var discarded = preview; invalidate(); ui.forget();
                var error = await retirement;
                if (error) { options.complete(error.message); return; }
                if (discarded) options.complete('취소했어. 셀은 변경하지 않았어.', {kind: 'operation', job_id: discarded.job.source.operation_job_id, status: 'FAILED'});
                options.setBusy(false);
            },
            cancel: function () { cancelled = true; if (abort) abort.abort(); }});
        return {
            reconcile: function (work, next, fallback) { workspace = work; target = next; invalidate(); return ui.reconcile(work.columns, fallback, work.task_type); },
            show: function (work, next, preferred, resetMode) { workspace = work; target = next; invalidate(); ui.show(work.columns, preferred || [], work.task_type, resetMode); },
            configure: function (operation, requestId) { invalidate(); originRequestId = requestId || null; ui.configure(operation); },
            preview: build,
            recommendExtraction: recommendExtraction,
            sampleRows: sampleRows,
            targets: ui.targets,
            pending: ui.pending,
            isProcessing: function () { return processing; },
            apply: apply,
            finalize: finalize,
            cancel: function () { cancelled = true; if (abort) abort.abort(); invalidate(); ui.forget(); },
            invalidate: invalidate,
            busy: function (busy) { ui.busy(busy, processing); },
            reset: function () { workspace = target = originRequestId = null; invalidate(); ui.forget(); }
        };
    };
})();
