"use strict";

(function () {
    window.createNormalizationTransformUI = function () {
        function element(name) { return document.getElementById("norm-transform-" + name); }
        var panel = document.getElementById("norm-transform");
        var columnSelect = element("column");
        var replace = document.getElementById("norm-replace-enabled");
        var find = document.getElementById("norm-replace-find");
        var replacement = document.getElementById("norm-replace-value");
        var ruleInputs = Array.from(element("rules").querySelectorAll("input[value]"));
        var busy = false;
        var hasPreview = false;

        function fillColumns(select, columns) {
            select.textContent = "";
            columns.forEach(function (column) {
                var option = document.createElement("option");
                option.value = String(column.column_id);
                option.textContent = column.header;
                select.appendChild(option);
            });
        }

        function setBusy(value, canCancel) {
            busy = value;
            panel.querySelectorAll("input, select, button").forEach(function (control) {
                control.disabled = busy;
            });
            element("cancel").hidden = !canCancel;
            element("cancel").disabled = !canCancel;
            element("apply").disabled = busy || !hasPreview;
        }

        function clearPreview() {
            hasPreview = false;
            element("result").hidden = true;
            element("summary").textContent = "";
            element("examples").textContent = "";
            element("apply").disabled = true;
        }

        function show(target) {
            clearPreview();
            // 표 밖의 열은 원본 행 연결과 함께 표 안으로 가져온 뒤 사용한다.
            var columns = target.columns.filter(function (column) { return column.column_id != null; });
            fillColumns(columnSelect, columns);
            var preferred = columns.find(function (column) { return column.role === "model_spec"; });
            if (preferred) columnSelect.value = String(preferred.column_id);
            panel.hidden = false;
        }

        function rules() {
            var selected = ruleInputs.filter(function (input) { return input.checked; })
                .map(function (input) { return {operation: input.value}; });
            if (replace.checked) {
                if (!find.value.length) throw new Error("찾을 문자열을 입력하세요. 공백도 입력한 그대로 사용합니다.");
                selected.push({operation: "replace", find_text: find.value, replace_text: replacement.value});
            }
            if (!selected.length) throw new Error("전처리 또는 문자열 치환을 선택하세요.");
            return selected;
        }

        function showPreview(data) {
            hasPreview = true;
            element("result").hidden = false;
            element("summary").textContent = data.snapshot.rows.length.toLocaleString() +
                "행 중 " + data.changed.toLocaleString() + "행 변경";
            var examples = [];
            data.snapshot.rows.some(function (row, index) {
                if (row.value !== data.values[index]) {
                    examples.push(row.excel_row + "행\n전: " + JSON.stringify(row.value) +
                        "\n후: " + JSON.stringify(data.values[index]));
                }
                return examples.length === 10;
            });
            element("examples").textContent = examples.join("\n\n") || "변경되는 값이 없습니다.";
            fillColumns(element("anchor"), data.snapshot.columns);
            element("anchor").value = String(data.snapshot.column.column_id);
            element("side").value = "after";
            element("name").value = (data.snapshot.column.header + " 정제").slice(0, 240);
        }

        return {
            show: show,
            hide: function () { clearPreview(); panel.hidden = true; },
            reset: function () {
                clearPreview();
                ruleInputs.forEach(function (input) { input.checked = false; });
                replace.checked = false;
                find.value = "";
                replacement.value = "";
                document.getElementById("norm-replace-fields").hidden = true;
            },
            columnId: function () { return columnSelect.value; },
            rules: rules,
            output: function () {
                if (!element("name").value.trim()) throw new Error("결과 열 이름을 입력하세요.");
                return {name: element("name").value, anchor: element("anchor").value,
                    side: element("side").value};
            },
            setAnchor: function (id) { element("anchor").value = String(id); },
            clearPreview: clearPreview,
            showPreview: showPreview,
            setBusy: setBusy,
            bind: function (handlers) {
                columnSelect.addEventListener("change", handlers.change);
                element("rules").addEventListener("input", function () {
                    document.getElementById("norm-replace-fields").hidden = !replace.checked;
                    handlers.change();
                });
                element("preview").addEventListener("click", handlers.preview);
                element("cancel").addEventListener("click", handlers.cancel);
                element("apply").addEventListener("click", handlers.apply);
                element("pick").addEventListener("click", handlers.pick);
            }
        };
    };
})();
