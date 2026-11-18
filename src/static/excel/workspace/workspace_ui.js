"use strict";
(function () {
    window.createWorkspaceUI = function () {
        function el(id) { return document.getElementById("work-" + id); }
        var columns = null, importChoices = [], importBusy = false;
        function importSelection() {
            return importChoices.filter(function (choice) { return choice.input.checked; }).map(function (choice) { return choice.column; });
        }
        function importMode(active) {
            el("import").hidden = !active;
        }
        function updateImport() {
            var selected = importSelection();
            var live = selected.some(function (column) { return column.origin === "live"; });
            el("import-order").hidden = !live;
            el("import-count").textContent = selected.length + "개 선택";
            el("import-hint").textContent = !selected.length ? "" : live
                ? "처음 선택하지 않은 열은 현재 원본에서 읽습니다. 기존 보관값을 대조하고 작업표의 원본 행 번호에 맞춰 추가합니다. 작업표를 정렬한 것은 괜찮습니다."
                : "처음 보관한 열은 조사 시작 당시의 값을 원본 행 번호로 맞춰 추가합니다.";
            el("import-add").disabled = importBusy || !selected.length || (live && !el("import-confirm").checked);
        }
        function choices(id, available, selected, empty) {
            var control = el(id); control.textContent = "";
            if (empty) { var option = document.createElement("option"); option.value = ""; option.textContent = empty; control.appendChild(option); }
            available.forEach(function (column) {
                var option = document.createElement("option"); option.value = String(column.column_id); option.textContent = column.header;
                control.appendChild(option);
            });
            control.value = selected || (empty ? "" : available.length ? String(available[0].column_id) : "");
        }
        function status(text) { el("status").textContent = text; }
        return {
            open: function (type) { el("panel").hidden = false; el("type").value = type; importMode(false); },
            hide: function () { el("panel").hidden = true; },
            reset: function () {
                el("panel").hidden = true;
                el("mapping").hidden = true;
                el("current").hidden = true;
                el("setup").hidden = false;
                el("import").hidden = true;


                columns = null;
                status("");
            },
            source: function (source, profile, change) {
                el("mapping").hidden = false;
                el("source").textContent = source.sheet_name + " · " + source.address + " · " + source.data_row_count.toLocaleString() + "행";
                el("required").textContent = "";
                var selects = profile.roles.map(function (role) {
                    var label = document.createElement("label");
                    label.textContent = role.labels[0] + (profile === window.workspaceProfiles.investigation ? " (선택)" : " *");
                    var select = document.createElement("select");
                    select.required = profile !== window.workspaceProfiles.investigation; label.appendChild(select); el("required").appendChild(label); return select;
                });
                columns = window.createWorkspaceColumns(selects, el("extra-columns"), profile.roles);
                columns.bind(change); columns.showSelection(source); change();
            },
            role: function () { return {column_id: el("role-column").value, role: el("role-value").value}; },
            importColumns: function (available) {
                el("import-confirm").checked = false;
                el("import-columns").textContent = available.length ? "" : "추가할 원본 열이 없습니다";
                importChoices = available.map(function (column) {
                    var label = document.createElement("label"), input = document.createElement("input");
                    label.className = "work-import-choice";
                    input.type = "checkbox"; input.value = String(column.column_id); input.disabled = importBusy;
                    input.addEventListener("change", function () { el("import-confirm").checked = false; updateImport(); });
                    label.appendChild(input); label.appendChild(document.createTextNode(column.header));
                    el("import-columns").appendChild(label);
                    return {column: column, input: input};
                });
                importMode(true); updateImport();
                if (el("import").scrollIntoView) el("import").scrollIntoView({block: "start"});
            },
            importSelection: importSelection,
            importPolicy: function () { return {original_order_confirmed: !!el("import-confirm").checked}; },
            mapping: function () { return columns ? columns.getMapping() : []; },
            extras: function () { return columns ? columns.getExtraColumns() : []; },
            valid: function (valid, count, extras, rows) {
                el("start").disabled = !valid;
                el("selection-summary").textContent = "역할 " + count + "개 지정 · 선택 " + extras + "열 · " + rows.toLocaleString() + "행";
            },
            current: function (workspace, target) {
                el("setup").hidden = true; el("current").hidden = false;
                choices("role-column", workspace.columns, el("role-column").value);
                var operators = {equals: "같음", not_equals: "다름", contains: "포함", blank: "빈칸", not_blank: "빈칸 아님"};
                el("operation-scope").textContent = workspace.row_filter ? "현재 조건: " +
                    (workspace.columns.find(function (c) { return String(c.column_id) === workspace.row_filter.column_id; }) || {header: "삭제된 열"}).header +
                    " · " + operators[workspace.row_filter.operator] + " · " + workspace.row_filter.value : "현재 조건: 전체 행";
                el("clear-filter").hidden = !workspace.row_filter;
                el("title").textContent = window.workspaceProfiles[workspace.task_type].name;
                el("current-summary").textContent = workspace.sheet_name + " · " + target.row_count.toLocaleString() + "행 작업 중";
                el("column-summary").textContent = workspace.columns.map(function (column) {
                    return column.header + " (" + (column.role === "reference" ? "일반" : column.role === "result" ? "결과" : "역할 지정") + ")" +
                        (column.description ? " — " + column.description : "");
                }).join("\n");
            },
            setup: function () { el("title").textContent = "작업 데이터 준비"; el("setup").hidden = false; el("mapping").hidden = true; el("current").hidden = true; el("import").hidden = true; },
            busy: function (busy, ready) {
                el("panel").querySelectorAll("button,select,input,textarea").forEach(function (control) { control.disabled = busy; });
                el("start").disabled = busy || !ready;
                importBusy = busy; updateImport();
                if (columns) columns.setBusy(busy);
            },
            status: status,
            bind: function (handlers) {
                el("import-confirm").addEventListener("change", updateImport);
                [
                    "select",
                    "start",
                    "restore",
                    "new", "refresh", "groups", "import-add", "role-save", "clear-filter"
                ].forEach(function (name) {
                    el(name).addEventListener("click", handlers[name]);
                });

                el("type").addEventListener("change", function () {
                    handlers.type(el("type").value);
                });
            }
        };
    };
})();
