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
                el("panel").hidden = true;
                el("mapping").hidden = true;
                el("current").hidden = true;
                el("setup").hidden = false;

                el("saved-workspaces").textContent = "";
                el("jobs").textContent = "";
                el("history-summary").textContent = "";

                columns = null;
                status("");
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
            savedWorkspaces: function (entries, current) {
                var select = el("saved-workspaces");
                select.textContent = "";

                if (!entries.length) {
                    var empty = document.createElement("option");
                    empty.value = "";
                    empty.textContent = "저장된 작업 시트가 없습니다.";
                    select.appendChild(empty);
                    return;
                }
                entries.forEach(function (entry) {
                    var option = document.createElement("option");
                    option.value = window.workspaceStore.identity(entry);
                    option.textContent = entry.sheet_name;
                    select.appendChild(option);
                });

                if (current) {
                    select.value = window.workspaceStore.identity(current);
                }
            },
            savedWorkspace: function () {
                return el("saved-workspaces").value;
            },
            jobs: function (records, workspace) {
                var select = el("jobs");
                var previous = select.value;
                select.textContent = "";

                var placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = "이어갈 실행 결과를 선택하세요.";
                select.appendChild(placeholder);
                var kinds = {
                    preprocess: "전처리",
                    split: "분리",
                    group: "통일",
                    replace: "치환",
                    map: "매핑"
                };
                var states = {
                    CREATED: "생성됨·미리보기 미완료",
                    PREVIEW_READY: "미리보기 준비",
                    APPLYING: "적용 시작·완료 미확인",
                    APPLIED: "적용 완료",
                    NO_CHANGE: "변경 없음",
                    CANCELLED: "취소",
                    FAILED: "실패",
                    UNKNOWN: "적용 여부 확인 필요"
                };
                var columns = workspace ? workspace.columns : [];
                records.slice().reverse().forEach(function (job) {
                    var option = document.createElement("option");
                    option.value = job.source.operation_job_id;

                    var names = job.result_column_ids.map(function (id) {
                        var column = columns.find(function (item) {
                            return String(item.column_id) === String(id);
                        });
                        return column ? column.header : "삭제된 결과 열";
                    });
                    option.textContent =
                        new Date(job.created_at).toLocaleString("ko-KR") +
                        " · " + kinds[job.source.operation.kind] +
                        " · " + states[job.status] +
                        (names.length ? " · " + names.join(", ") : "");

                    option.disabled = job.status !== "APPLIED";
                    select.appendChild(option);
                });
                select.value = records.some(function (job) {
                    return job.source.operation_job_id === previous &&
                        job.status === "APPLIED";
                }) ? previous : "";

                el("history-summary").textContent = !workspace
                    ? "먼저 작업 시트를 선택하세요."
                    : records.length
                        ? "실행 " + records.length +
                            "개 · 완료된 결과의 현재 값으로 이어갑니다."
                        : "현재 대화와 작업 시트의 실행 기록이 없습니다. " +
                            "서버를 재시작하면 실행 기록은 사라집니다.";
            },
            selectedJob: function () {
                return el("jobs").value;
            },
            setup: function () { el("title").textContent = "작업 데이터 준비"; el("setup").hidden = false; el("mapping").hidden = true; el("current").hidden = true; },
            busy: function (busy, ready) {
                el("panel").querySelectorAll("button,select,input,textarea").forEach(function (control) { control.disabled = busy; });
                el("start").disabled = busy || !ready;
                if (columns) columns.setBusy(busy);
            },
            status: status,
            bind: function (handlers) {
                [
                    "select",
                    "start",
                    "restore",
                    "target",
                    "return",
                    "new",
                    "switch",
                    "resume-job",
                    "reload-history"
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
