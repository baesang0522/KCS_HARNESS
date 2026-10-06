"use strict";
(function () {
    window.createWorkspaceUI = function () {
        function el(id) { return document.getElementById("work-" + id); }
        var columns = null;
        function status(text) { el("status").textContent = text; }
        return {
            open: function (type) { el("panel").hidden = false; el("type").value = type; },
            hide: function () { el("panel").hidden = true; },
            reset: function () {
                el("panel").hidden = true; el("mapping").hidden = true; el("current").hidden = true;
                el("setup").hidden = false; columns = null; status("");
            },
            source: function (source, profile, change) {
                el("mapping").hidden = false;
                el("source").textContent = source.sheet_name + " · " + source.address + " · " + source.data_row_count.toLocaleString() + "행";
                el("required").textContent = "";
                var selects = profile.roles.map(function (role) {
                    var label = document.createElement("label");
                    label.textContent = role.labels[0] + " *";
                    var select = document.createElement("select");
                    select.required = true; label.appendChild(select); el("required").appendChild(label); return select;
                });
                columns = window.createWorkspaceColumns(selects, el("extra-columns"), profile.roles);
                columns.bind(change); columns.showSelection(source); change();
            },
            mapping: function () { return columns ? columns.getMapping() : []; },
            extras: function () { return columns ? columns.getExtraColumns() : []; },
            valid: function (valid, count, extras, rows) {
                el("start").disabled = !valid;
                el("selection-summary").textContent = "필수 " + count + "/3 지정 · 추가 " + extras + "열 · " + rows.toLocaleString() + "행";
            },
            current: function (workspace, target) {
                el("setup").hidden = true; el("current").hidden = false;
                el("title").textContent = window.workspaceProfiles[workspace.task_type].name;
                el("current-summary").textContent = workspace.sheet_name + " · " + target.row_count.toLocaleString() + "행 작업 중";
                el("column-summary").textContent = workspace.columns.map(function (column) {
                    return column.header + " (" + (column.role === "reference" ? "추가" : column.role === "result" ? "결과" : "필수") + ")" +
                        (column.description ? " — " + column.description : "");
                }).join("\n");
            },
            setup: function () { el("title").textContent = "작업 데이터 준비"; el("setup").hidden = false; el("mapping").hidden = true; el("current").hidden = true; },
            busy: function (busy, ready) {
                el("panel").querySelectorAll("button,select,input,textarea").forEach(function (control) { control.disabled = busy; });
                el("start").disabled = busy || !ready;
                if (columns) columns.setBusy(busy);
            },
            status: status,
            bind: function (handlers) {
                ["select", "start", "restore", "target", "return", "new"].forEach(function (name) { el(name).addEventListener("click", handlers[name]); });
                el("type").addEventListener("change", function () { handlers.type(el("type").value); });
            }
        };
    };
})();
