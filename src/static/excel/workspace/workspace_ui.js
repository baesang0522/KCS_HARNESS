"use strict";
(function () {
    window.createWorkspaceUI = function (messages) {
        function el(id) { return document.getElementById("work-" + id); }
        var columns = null, importChoices = [], importBusy = false, mode = "work", lastWarning = "", lastFinal = "";
        function importSelection() {
            return importChoices.filter(function (choice) { return choice.input.checked; }).map(function (choice) { return choice.column; });
        }
        function setMode(next) {
            mode = next;
            el("import").hidden = mode !== "import";
            if (mode === "import") el("title").textContent = "열 추가";
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
        function status(text) { el("status").textContent = text; if (el("panel").hidden) document.getElementById("notice").textContent = text; }
        return {
            open: function (type) { el("panel").hidden = false; el("type").value = type; setMode("work"); },
            mode: setMode,
            hide: function () { el("panel").hidden = true; },
            reset: function () {
                el("panel").hidden = true;
                el("mapping").hidden = true;
                el("current").hidden = true;
                el("setup").hidden = false;
                setMode("work");


                columns = null;
                lastWarning = lastFinal = "";
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
                setMode("import"); updateImport();
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
                el("title").textContent = mode === "import" ? "열 추가" : "작업 데이터 준비";
            },
            setup: function () { el("title").textContent = "작업 데이터 준비"; el("setup").hidden = false; el("mapping").hidden = true; el("current").hidden = true; setMode("work"); },
            busy: function (busy, ready) {
                el("panel").querySelectorAll("button,select,input,textarea").forEach(function (control) { control.disabled = busy; });
                el("start").disabled = busy || !ready;
                importBusy = busy; updateImport();
                if (columns) columns.setBusy(busy);
            },
            finalRecord: function (record, workspace) {
                var text = record ? "최종 결과 기록 · " + record.column_ids.map(function (id) { return (workspace.columns.find(function (c) { return String(c.column_id) === id; }) || {header: id}).header; }).join(", ") + " · " + record.row_count + "행" : "";
                if (text && text !== lastFinal && messages) messages.say(text); lastFinal = text;
            },
            review: function (workspace) {
                var ids = window.resultDependencies.required(workspace);
                var text = ids.length ? "재검토 필요: " + ids.map(function (id) { return (workspace.columns.find(function (c) { return String(c.column_id) === id; }) || {header: "삭제된 열"}).header; }).join(", ") + " — 입력이나 범위가 바뀌었어. 기존 결과값은 유지했으니 필요한 작업을 다시 요청해 줘." : "";
                if (text && text !== lastWarning && messages) messages.say(text); lastWarning = text;
            },
            status: status,
            bind: function (handlers) {
                el("import-confirm").addEventListener("change", updateImport);
                ["select", "start", "restore", "import-add"
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
