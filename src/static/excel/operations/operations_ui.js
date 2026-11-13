"use strict";
(function () {
    window.createOperationsUI = function () {
        function el(id) { return document.getElementById("op-" + id); }
        var columns = [], currentTaskType = null, hasPreview = false, mapping = window.createMappingEditor();
        function extractionColumn() {
            var models = columns.filter(function (column) { return column.role === "model_spec"; });
            return models.length === 1 ? String(models[0].column_id) : "";
        }
        function fill(select, selected) {
            select.textContent = "";
            columns.forEach(function (column) {
                if (select === el("column") && el("kind").value === "extract" && String(column.column_id) !== extractionColumn()) return;
                var option = document.createElement("option"); option.value = String(column.column_id);
                option.textContent = column.header; option.selected = selected.indexOf(option.value) >= 0;
                select.appendChild(option);
            });
        }
        function kind() {
            var value = el("kind").value;
            fill(el("column"), [el("column").value]);
            el("column").disabled = value === "extract";
            ["preprocess", "split", "group", "replace", "map", "extract", "set"].forEach(function (name) { el(name).hidden = name !== value; });
            el("single").hidden = value === "group";
            var automatic = el("group-mode").value === "first_non_empty";
            el("group-manual").hidden = automatic;
            el("group-auto").hidden = !automatic;
        }
        function keys() { return Array.from(el("keys").selectedOptions).map(function (o) { return o.value; }); }
        function targets() {
            return el("kind").value === "group" ? Array.from(new Set(keys().concat(el("value-column").value).filter(Boolean))) : [el("column").value];
        }
        function clear() { el("extraction-preview").hidden = true; el("settings").hidden = false; el("preview").hidden = false; el("finalize").hidden = false; hasPreview = false; el("result").hidden = true; el("final-review").hidden = true; el("apply").disabled = true; }
        function rules() {
            return Array.from(el("rules").querySelectorAll("input:checked")).map(function (input) {
                var words = input.value === "remove_words" ? el("words").value.split("\n").map(function (v) { return v.trim(); }).filter(Boolean) : [];
                return {operation: input.value, words: words};
            });
        }
        return {
            targets: targets,
            reconcile: function (available, fallback, taskType) {
                currentTaskType = taskType;
                var ids = new Set(available.map(function (column) { return String(column.column_id); }));
                var lostTarget = targets().some(function (id) { return !ids.has(id); });
                if (lostTarget) {
                    this.show(available, fallback, taskType, true);
                } else {
                    columns = available;
                    ["column", "keys", "value-column", "anchor", "existing-column"].forEach(function (name) {
                        var selected = Array.from(el(name).selectedOptions).map(function (option) { return option.value; });
                        fill(el(name), selected.filter(function (id) { return ids.has(id); }));
                    });
                }
                return lostTarget;
            },
            show: function (available, preferred, taskType, resetMode) {
                columns = available; currentTaskType = taskType; clear(); mapping.reset();
                el("extraction-suggestions").textContent = "";
                if (resetMode) {
                    el("kind").value = "preprocess"; el("part").value = "all"; el("group-mode").value = "manual"; el("extraction-mode").value = "";
                    el("rules").querySelectorAll("input").forEach(function (input) { input.checked = false; });
                    ["words", "find", "replacement", "delimiter", "source-row", "group-value", "assigned-value"].forEach(function (id) { el(id).value = ""; });
                }
                fill(el("column"), preferred.slice(0, 1).map(String));
                var defaults = columns.filter(function (c) { return taskType === "counterparty_cleanup" ?
                    ["country_code", "company_name"].indexOf(c.role) >= 0 : c.role === "trade_name"; }).map(function (c) { return String(c.column_id); });
                fill(el("keys"), defaults); fill(el("value-column"), preferred.slice(0, 1).map(String)); fill(el("anchor"), preferred.map(String)); fill(el("existing-column"), preferred.slice(0, 1).map(String));
                if (resetMode) el("output-mode").value = "new"; kind();
            },
            operation: function () {
                var type = el("kind").value;
                var ids = type === "group" ? keys() : targets();
                var selected = type === "preprocess" ? rules() : [];
                if (type === "preprocess" && !selected.length) return null;
                var delimiter = type === "split" && el("delimiter-mode").value === "custom" ? el("delimiter").value : null;
                var operation = {kind: type, column_ids: ids, rules: selected, delimiter: delimiter};
                if (type === "group") {
                    operation.value_column_id = el("value-column").value;
                    operation.group_mode = el("group-mode").value;

                    operation.source_row = null;
                    operation.representative = null;

                    if (operation.group_mode === "manual") {
                        operation.source_row = Number(el("source-row").value);
                        operation.representative = el("group-value").value || null;


                    }
                }
                if (type === "set") operation.assigned_value = el("assigned-value").value;
                if (type === "split") operation.part = el("part").value;
                if (type === "replace") {
                    operation.find = el("find").value; operation.replacement = el("replacement").value;
                }
                if (type === "map") operation.mappings = mapping.get();
                if (type === "extract") {
                    operation.extraction_mode = el("extraction-mode").value || null;
                }
                return operation;
            },
            configure: function (operation) {
                if (operation.kind === "extract" && (!extractionColumn() || operation.column_ids.length !== 1 || operation.column_ids[0] !== extractionColumn())) {
                    throw new Error(window.errorMessages.MODEL_SPEC_REQUIRED);
                }
                if (!operation.column_ids.concat(operation.value_column_id || []).every(function (id) { return columns.some(function (c) { return String(c.column_id) === id; }); })) {
                    throw new Error("현재 작업에 없는 열입니다. 범위를 다시 확인하세요.");
                }
                clear(); el("kind").value = operation.kind;el("group-mode").value = operation.group_mode || "manual"; kind();
                fill(el("column"), operation.column_ids); fill(el("keys"), operation.column_ids);
                if (operation.value_column_id) fill(el("value-column"), [operation.value_column_id]);
                el("source-row").value = operation.source_row || "";
                el("group-value").value = operation.representative || "";
                el("part").value = operation.part || "all";
                el("extraction-mode").value = operation.extraction_mode || "";
                // 모델이 제안한 적용 순서를 카드에도 그대로 반영한다.
                operation.rules.forEach(function (rule) {
                    var input = Array.from(el("rules").querySelectorAll("input")).find(function (item) { return item.value === rule.operation; });
                    if (input) el("rules").appendChild(input.parentElement.parentElement);
                });
                el("rules").querySelectorAll("input").forEach(function (input) {
                    input.checked = operation.rules.some(function (rule) { return rule.operation === input.value; });
                });
                el("words").value = operation.rules.filter(function (r) { return r.operation === "remove_words"; }).flatMap(function (r) { return r.words; }).join("\n");
                el("delimiter-mode").value = operation.delimiter === null ? "whitespace" : "custom";
                el("assigned-value").value = operation.assigned_value || "";
                el("delimiter").value = operation.delimiter || "";
                el("find").value = operation.find || ""; el("replacement").value = operation.replacement || "";
                mapping.set(operation.mappings || []);
            },
            preview: function (data) {
                hasPreview = true; el("result").hidden = false;
                el("settings").hidden = el("preview").hidden = el("finalize").hidden = true;
                var count = data.values.length.toLocaleString();
                el("summary").textContent = count + "행 확인 · 결과 " + data.names.length + "열 · " + data.changed + "행 변경";
                if (data.operation.kind === "extract") {
                    var counts = {"단일 후보": 0, "미검출": 0, "확인 필요 · 복수 후보": 0};
                    data.values.forEach(function (row) { counts[row[1]] += 1; });
                    el("summary").textContent = count + "행 확인 · 결과 2열 · 단일 후보 " + counts["단일 후보"] +
                        "행 · 미검출 " + counts["미검출"] + "행 · 복수 후보 " + counts["확인 필요 · 복수 후보"] + "행";
                    var examples = el("extraction-preview");
                    examples.textContent = "앞 10행 미리보기";
                    examples.hidden = false;
                    data.values.slice(0, 10).forEach(function (row, index) {
                        var item = document.createElement("p");
                        item.style.whiteSpace = "pre-wrap";
                        item.textContent = data.snapshot.rows[index].excel_row + "행: " +
                            data.snapshot.rows[index].values[0].slice(0, 160) + " → " +
                            (row[0].slice(0, 160) || "(후보 없음)") + " · " + row[1];
                        examples.appendChild(item);
                    });
                }
                if (data.operation.kind === "group") {
                    var counts = {"변경": 0, "유지": 0, "확인 필요": 0};

                    data.values.forEach(function (row) {
                        counts[row[1]] += 1;
                    });

                    el("summary").textContent =
                        count + "행 확인 · 결과 2열" +
                        " · 변경 " + counts["변경"].toLocaleString() + "행" +
                        " · 유지 " + counts["유지"].toLocaleString() + "행" +
                        " · 확인 필요 " + counts["확인 필요"].toLocaleString() + "행";

                    if (data.operation.group_mode === "first_non_empty") {
                        el("summary").textContent +=
                            " · 그룹별 첫 번째 빈칸 아닌 값 사용";
                    } else {
                        var source = data.snapshot.rows.find(function (row) {
                            return row.excel_row === data.operation.source_row;
                        });
                        var value = data.operation.representative == null
                            ? source.values[source.values.length - 1]
                            : data.operation.representative;

                        el("summary").textContent += " · 적용 대표값: " + value;
                    }
                }
                var column = data.snapshot.columns[data.operation.kind === "group" ? data.snapshot.columns.length - 1 : 0];
                fill(el("anchor"), [String(column.column_id)]);
                el("name").value = column.header + ({split: data.operation.part === "last" ? " 마지막 단어" : " 단어", replace: " 치환", map: " 대표값", group: " 통일", extract: " 모델명 후보"}[data.operation.kind] || " 정제");
                el("side").value = "after";
                var existing = el("output-mode").value === "existing";
                el("new-placement").hidden = existing;
                el("apply").textContent = existing ? "확인한 결과를 기존 열에 반영" : "확인한 결과를 새 열로 만들기";
                if (existing) {
                    var destination = data.snapshot.output_columns.find(function (c) { return String(c.column_id) === data.snapshot.output_column_id; });
                    el("summary").textContent += " · 기존 ‘" + destination.header + "’ 열의 " + data.changed + "행 변경";
                    var examples = el("extraction-preview"); examples.hidden = false; examples.textContent = "기존 값 → 적용할 값 (앞 10행)";
                    data.values.slice(0, 10).forEach(function (row, i) {
                        var line = document.createElement("p");
                        line.textContent = data.snapshot.rows[i].excel_row + "행: " + data.snapshot.rows[i].destination.slice(0, 160) + " → " + row[0].slice(0, 160) +
                            (["group", "extract"].includes(data.operation.kind) ? " · " + row[1] : ""); examples.appendChild(line);
                    });
                    if (data.operation.kind === "split" && data.names.length > 1) {
                        el("summary").textContent += " · 여러 열로 분리하는 결과는 새 열 저장을 선택하세요.";
                    } else if (data.names.length > 1) el("summary").textContent += " · 상태 정보는 미리보기에서 확인하고 첫 번째 결과값만 반영합니다.";
                }
                if (data.snapshot.row_filter) el("summary").textContent += " · 작업 조건에 맞는 행만 처리합니다.";
            },
            destination: function () { return el("output-mode").value === "existing" ? el("existing-column").value : null; },
            output: function () {
                if (el("output-mode").value === "existing") return {mode: "existing", column_id: el("existing-column").value,
                    name: columns.find(function (c) { return String(c.column_id) === el("existing-column").value; }).header.slice(0, 200)};
                var name = el("name").value.trim();
                if (!name) throw new Error("결과 열 이름을 입력하세요.");
                return {anchor: el("anchor").value, side: el("side").value, name: name};
            },
            extractionSuggestions: function (data) {
                var box = el("extraction-suggestions");
                box.textContent = "전체 대상 " + data.sample_count.toLocaleString() + "행 검사 완료 · " +
                    (data.suggestions.length
                        ? "추천은 자동 적용되지 않습니다."
                        : "일치 패턴이 없습니다. 다른 범위나 추출 방식을 확인하세요.");
                data.suggestions.forEach(function (suggestion) {
                    var text = document.createElement("p");
                    text.textContent = suggestion.label + " · 일치 " + suggestion.matched_rows + "행 · 복수 후보 " + suggestion.multiple_rows + "행";
                    box.appendChild(text);
                    suggestion.examples.forEach(function (example) {
                        var line = document.createElement("p");
                        line.textContent = example.before + " → " + example.after;
                        box.appendChild(line);
                    });
                    var button = document.createElement("button");
                    button.type = "button";
                    button.textContent = "이 방식 선택";
                    button.dataset.extractionMode = suggestion.mode;
                    box.appendChild(button);
                });
            },
            clear: clear,
            catalog: mapping.catalog,
            finalReview: function (snapshot, blanks) {
                el("final-summary").textContent = snapshot.columns.map(function (c) { return c.header; }).join(", ") +
                    " · " + snapshot.rows.length.toLocaleString() + "행 · 빈 셀 " + blanks.toLocaleString() + "개";
                el("final-review").hidden = false;
            },
            busy: function (busy, processing) {
                document.getElementById("operations").querySelectorAll("button,select,input,textarea").forEach(function (control) { control.disabled = busy; });
                el("column").disabled = busy || el("kind").value === "extract";
                el("apply").disabled = busy || !hasPreview;
                el("cancel").hidden = !processing; el("cancel").disabled = !processing;
            },
            bind: function (handlers) {
                ["preview", "apply", "cancel", "finalize", "confirm-final", "cancel-final", "load-values", "edit"].forEach(function (name) { el(name).addEventListener("click", handlers[name]); });
                mapping.bind(function () { clear(); handlers.change(); }, handlers.status);
                el("recommend-extraction").addEventListener("click", handlers.recommend);
                el("extraction-suggestions").addEventListener("click", function (event) {
                    var button = event.target.closest("button[data-extraction-mode]");
                    if (!button || button.disabled) return;
                    el("extraction-mode").value = button.dataset.extractionMode;
                    clear(); handlers.change();
                });
                document.getElementById("op-settings").addEventListener("input", function (event) {
                    if (event.target.id === "op-column") mapping.reset();
                    if (["op-kind", "op-column"].includes(event.target.id)) el("extraction-suggestions").textContent = "";
                    kind(); clear(); handlers.change();
                    if (["op-kind", "op-column"].includes(event.target.id) && el("kind").value === "extract") handlers.recommend();
                });
                el("rules").addEventListener("click", function (event) {
                    var button = event.target.closest("button[data-move]");
                    if (!button) return;
                    var row = button.parentElement;
                    if (row.previousElementSibling) el("rules").insertBefore(row, row.previousElementSibling);
                    clear(); handlers.change();
                });
            }
        };
    };
})();
