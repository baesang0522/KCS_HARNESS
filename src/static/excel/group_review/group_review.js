"use strict";
(function () {
    window.createGroupReview = function (options) {
        var model = window.groupReviewModel, sheet = window.operationsSheet;
        var workspace = null, review = null, items = [], selected = new Set(), chosen = new Set();
        var refs = [], editing = null, base = null, preview = null, lastOutput = null;
        function el(id) { return document.getElementById("gr-" + id); }
        function status(text) { el("status").textContent = text; }
        function invalidate() { preview = null; el("apply").disabled = true; el("preview-text").textContent = ""; }
        function busy(value) {
            el("panel").querySelectorAll("button,select,input").forEach(function (control) { control.disabled = value; });
            el("apply").disabled = value || !preview;
            el("filter").disabled = value || !lastOutput;
        }
        async function run(action) {
            if (options.isBusy()) return;
            options.setBusy(true);
            try { await action(); }
            catch (error) { invalidate(); status(error.message); }
            finally { options.setBusy(false); }
        }
        function progress(label, done, total) { status(label + " · " + done + "/" + total); }
        function add(parent, tag, text, className) {
            var node = document.createElement(tag); node.textContent = text || "";
            if (className) node.className = className;
            parent.appendChild(node); return node;
        }
        function button(parent, text, action) {
            var node = add(parent, "button", text); node.type = "button"; node.disabled = options.isBusy();
            node.addEventListener("click", function () { return run(action); }); return node;
        }
        function choice(parent, text, checked, action) {
            var label = add(parent, "label", "", "gr-choice"), input = document.createElement("input");
            input.type = "checkbox"; input.disabled = options.isBusy(); input.checked = checked; label.appendChild(input);
            label.appendChild(document.createTextNode(text)); input.addEventListener("change", function () { action(input.checked); });
            return input;
        }
        function selectOptions(id, columns, empty) {
            var control = el(id); control.textContent = "";
            if (empty) { var first = add(control, "option", empty); first.value = ""; }
            columns.forEach(function (column) { var option = add(control, "option", column.header); option.value = String(column.column_id); });
        }
        function resetSelection() { selected.clear(); editing = base = null; el("name").value = ""; el("base").textContent = "값 목록의 ‘비교 기준’을 선택하세요."; el("candidates").textContent = ""; invalidate(); }
        function selectedItems() { return items.filter(function (item) { return selected.has(item.key); }); }
        function summary(item) {
            return item.values.map(function (value, i) {
                var column = workspace.columns.find(function (c) { return String(c.column_id) === review.column_ids[i]; });
                return (i ? (column ? column.header : "삭제된 열") + ": " : "") + value;
            }).join("\n") + "\n" + item.ids.length + "행";
        }
        function renderSelection() { el("selection").textContent = selected.size + "개 값 선택 · " + selectedItems().reduce(function (n, item) { return n + item.ids.length; }, 0) + "행"; }
        async function current() {
            var input = await options.getInput();
            if (workspace && workspace.workspace_id !== input.workspace.workspace_id) throw new Error("작업표가 바뀌었습니다. 묶음 검토를 다시 여세요.");
            workspace = input.workspace;
            return input;
        }
        async function read(ids, destination, identities) {
            var input = await current();
            return sheet.read(Object.assign({}, workspace, {row_filter: null}), input.target, ids, progress, function () {}, destination, null, identities);
        }
        async function commit(next) {
            await options.saveReview(next); review = next; invalidate();
        }
        async function locate(item) {
            var snapshot = await read(review.column_ids, null, [item.ids[0]]);
            await Excel.run(async function (context) {
                var info = await window.workspaceTable.layout(context, workspace);
                info.sheet.activate(); info.sheet.getRangeByIndexes(snapshot.rows[0].excel_row - 1, snapshot.columns[0].column_index, 1, 1).select();
                await context.sync();
            });
            status("현재 작업표의 해당 행으로 이동했습니다.");
        }
        function renderValues() {
            var query = el("search").value.toUpperCase();
            var visible = items.filter(function (item) { return item.values.some(function (v) { return v.toUpperCase().includes(query); }); });
            el("values").textContent = "";
            visible.slice(0, 100).forEach(function (item) {
                var row = add(el("values"), "div", "", "gr-item");
                choice(row, summary(item), selected.has(item.key), function (checked) {
                    if (checked) selected.add(item.key); else selected.delete(item.key);
                    invalidate(); renderSelection();
                });
                button(row, "비교 기준", async function () { el("query").value = ""; base = item; el("base").textContent = "비교 기준: " + summary(item); el("candidates").textContent = ""; });
                button(row, "실제 행 보기", function () { return locate(item); });
            });
            el("count").textContent = "전체 " + items.length + "개 값 · 검색 " + visible.length + "개 중 최대 100개 표시. 참고 정보가 다르면 별도 항목입니다.";
            renderSelection();
        }
        function renderGroups() {
            el("groups").textContent = "";
            review.groups.forEach(function (group) {
                var row = add(el("groups"), "div", "", "gr-item");
                var labels = {draft: "검토 중", confirmed: "확정", review: "데이터 변경 · 재검토 필요"};
                choice(row, group.name + " · " + labels[group.status] + " · " + group.members.reduce(function (n, m) { return n + m.ids.length; }, 0) + "행", chosen.has(group.id), function (checked) {
                    if (checked) chosen.add(group.id); else chosen.delete(group.id); invalidate();
                });
                button(row, "구성 확인 / 수정", async function () {
                    await load();
                    var live = review.groups.find(function (g) { return g.id === group.id; });
                    var ids = new Set(live.members.flatMap(function (m) { return m.ids; }));
                    var visibleIds = new Set(items.flatMap(function (item) { return item.ids; }));
                    if (Array.from(ids).some(function (id) { return !visibleIds.has(id); })) throw new Error("현재 범위 밖이거나 삭제·빈값 변경된 구성원이 있습니다. 전체 범위에서 확인하세요. 삭제·빈값 행을 제외하려면 묶음을 해제하고 남은 값으로 다시 저장하세요.");
                    editing = live.id; el("name").value = live.name;
                    selected = new Set(items.filter(function (item) { return item.ids.some(function (id) { return ids.has(id); }); }).map(function (item) { return item.key; }));
                    el("search").value = ""; renderValues();
                    status("현재 값으로 구성을 표시했습니다. 건수와 선택을 확인하고 저장하세요. 제외할 값의 체크를 풀면 묶음에서 빠집니다.");
                });
                button(row, "확정", async function () {
                    var snapshot = await read(review.column_ids), next = JSON.parse(JSON.stringify(review));
                    model.reconcile(next, snapshot.rows);
                    var live = next.groups.find(function (g) { return g.id === group.id; });
                    if (live.status === "review") { await commit(next); renderGroups(); throw new Error("구성원의 값이 바뀌었습니다. ‘구성 확인 / 수정’에서 현재 값을 검토하고 다시 저장하세요."); }
                    live.status = "confirmed"; await commit(next); renderGroups(); status("묶음을 확정했습니다. 셀은 변경하지 않았습니다.");
                });
                button(row, "묶음 해제", async function () {
                    var next = JSON.parse(JSON.stringify(review)); next.groups = next.groups.filter(function (g) { return g.id !== group.id; });
                    await commit(next); chosen.delete(group.id); if (editing === group.id) resetSelection(); renderGroups(); renderValues();
                    status("묶음 기록을 해제했습니다. 이미 반영한 셀 값은 유지됩니다.");
                });
            });
        }
        async function load() {
            el("work").hidden = true; invalidate(); resetSelection(); lastOutput = null; el("output").hidden = true;
            var ids = [el("column").value].concat(refs.filter(function (r) { return r.input.checked && r.id !== el("column").value; }).map(function (r) { return r.id; }).sort());
            if (!ids[0]) throw new Error("묶을 열을 선택하세요.");
            var input = await current(), filter = el("scope").value === "current" ? workspace.row_filter : null;
            var readIds = ids.slice(); if (filter && !readIds.includes(filter.column_id)) readIds.push(filter.column_id);
            var snapshot = await read(readIds);
            var id = model.key(ids), saved = (workspace.group_reviews || []).find(function (r) { return r.id === id; });
            var next = saved ? JSON.parse(JSON.stringify(saved)) : {id: id, column_ids: ids, groups: [], rejected: []};
            model.reconcile(next, snapshot.rows); await commit(next);
            var rows = snapshot.rows.filter(function (row) { return !filter || sheet.matches(row.values[readIds.indexOf(filter.column_id)], filter); });
            items = model.catalog(rows, ids.length); chosen.clear();
            selectOptions("destination", workspace.columns, "새 열에 기록");
            el("work").hidden = false; renderValues(); renderGroups();
            status("현재 값을 읽었습니다. 필요한 값만 선택해 묶거나, 비교 기준을 골라 후보를 찾으세요. 새 행은 기존 묶음에 자동 추가하지 않습니다.");
        }
        async function compare() {
            var query = el("query").value.trim();
            if (query) base = {key: null, values: [query], ids: []};
            if (!base) throw new Error("찾을 기준값을 입력하거나 값 목록에서 비교 기준을 선택하세요.");
            if (!base.ids.length && el("same").checked && review.column_ids.length > 1) throw new Error("참고 열 일치 조건을 쓰려면 실제 값 목록에서 비교 기준을 선택하세요.");
            // 비교 결과를 검토하던 중 바뀐 값은 다음 적용 전에 다시 검증한다.
            var fresh = await read(review.column_ids), byId = new Map(fresh.rows.map(function (row) { return [row.identity, row]; }));
            if (model.changed({members: items}, byId, review.column_ids.length)) throw new Error("불러온 값이 바뀌었습니다. 현재 값을 다시 불러온 뒤 비교하세요.");
            var normalized = el("normalize").checked, same = el("same").checked;
            var candidates = model.candidates(items, base, same, normalized, review.rejected);
            var baseValue = model.normalize(base.values[0], normalized);
            var unique = Array.from(new Set([baseValue].concat(candidates.map(function (c) { return model.normalize(c.values[0], normalized); }))));
            if (unique.some(function (v) { return v.length > 200; })) throw new Error("유사도 비교는 값당 200자까지입니다. 긴 규격은 먼저 모델명 등을 추출한 열로 비교하세요. 수동 묶기는 가능합니다.");
            var result = await options.api.requestJson("/operations/similarity", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
                settings: {column_id: review.column_ids[0], method: el("method").value, base_value: baseValue},
                rows: unique.map(function (value, i) { return {excel_row: i + 1, value: value}; })
            })});
            var scores = new Map([[baseValue, 100]]);
            result.rows.forEach(function (row) { scores.set(row.candidate, row.score); });
            candidates.sort(function (a, b) { return (scores.get(model.normalize(b.values[0], normalized)) || 0) - (scores.get(model.normalize(a.values[0], normalized)) || 0); });
            el("candidates").textContent = "";
            candidates.slice(0, 100).forEach(function (item) {
                var row = add(el("candidates"), "div", "", "gr-item");
                var score = scores.get(model.normalize(item.values[0], normalized));
                add(row, "p", summary(item) + "\n문자열 유사도 " + Number(score || 0).toFixed(1) + "점" + (same ? " · 참고 열 일치" : "") + (normalized ? " · 공백·대소문자 정리 기준" : " · 원래 표기 기준"));
                button(row, base.ids.length ? "기준값과 함께 선택" : "이 후보 선택", async function () { if (base.ids.length) selected.add(base.key); selected.add(item.key); renderValues(); invalidate(); });
                button(row, "다른 대상", async function () {
                    var next = JSON.parse(JSON.stringify(review)), pair = model.pair(base.key || model.key(base.values), item.key);
                    if (!next.rejected.includes(pair)) next.rejected.push(pair);
                    await commit(next); row.hidden = true; status("다른 대상으로 저장했습니다. 같은 기준과 후보는 다음 추천에서 제외합니다.");
                });
                button(row, "실제 행 보기", function () { return locate(item); });
            });
            status(candidates.length + "개 후보 중 점수순 최대 100개를 표시했습니다. 점수는 동일 대상이라는 확정이 아닙니다.");
        }
        async function buildPreview() {
            invalidate(); lastOutput = null;
            var groups = review.groups.filter(function (g) { return chosen.has(g.id); });
            if (!groups.length || groups.some(function (g) { return g.status !== "confirmed"; })) throw new Error("반영할 확정 묶음만 선택하세요.");
            var identities = groups.flatMap(function (g) { return g.members.flatMap(function (m) { return m.ids; }); });
            var destination = el("destination").value || null;
            var snapshot = await read(review.column_ids, destination, identities);
            var next = JSON.parse(JSON.stringify(review));
            var byId = new Map(snapshot.rows.map(function (row) { return [row.identity, row]; }));
            var changed = next.groups.filter(function (g) { return chosen.has(g.id) && model.changed(g, byId, review.column_ids.length); });
            if (changed.length) {
                changed.forEach(function (g) { g.status = "review"; }); await commit(next); renderGroups();
                throw new Error("확정 후 값이 바뀐 묶음이 있습니다. 현재 값을 불러와 해당 묶음을 다시 검토하세요.");
            }
            var mark = el("output-kind").value === "mark", value = el("mark").value;
            var name = el("output-name").value.trim(); if (!destination && !name) throw new Error("새 열 이름을 입력하세요.");
            var assignments = new Map(); groups.forEach(function (g) { g.members.forEach(function (m) { m.ids.forEach(function (id) { assignments.set(id, mark ? value : g.name); }); }); });
            var values = snapshot.rows.map(function (row) { return [assignments.get(row.identity)]; });
            preview = {snapshot: snapshot, values: values, name: name, mark: mark, value: value,
                output: destination ? {mode: "existing", column_id: destination} : {mode: "new", anchor: review.column_ids[0], side: "after", name: name}};
            var changes = destination ? snapshot.rows.filter(function (row, i) { return row.destination !== values[i][0]; }).length : values.length;
            el("preview-text").textContent = groups.length + "개 묶음 · " + values.length + "행 대상 · " + changes + "행 변경\n" +
                (destination ? "선택한 기존 열의 대상 행만 변경합니다." : "새 열을 만듭니다. 선택 밖의 행은 빈칸입니다.") + "\n" +
                snapshot.rows.slice(0, 5).map(function (row, i) { return row.excel_row + "행: " + (destination ? row.destination : "(새 셀)") + " → " + values[i][0]; }).join("\n");
            status("변경 내용을 확인한 뒤 반영하세요. 셀 편집·정렬 후에는 미리보기를 다시 만드세요.");
        }
        async function apply() {
            if (!preview) throw new Error("먼저 변경 내용을 확인하세요.");
            var data = preview; invalidate();
            var result = await sheet.write(data.snapshot, data.values, [data.name || "묶음"], data.output, progress);
            await options.register(result);
            selectOptions("destination", workspace.columns, "새 열에 기록");
            el("destination").value = String(result.columns[0].column_id); outputControls();
            lastOutput = data.mark && data.value.trim() ? {column_id: String(result.columns[0].column_id), value: data.value} : null;
            status(result.row_count + "행에 반영했습니다. 조사 대상 조건은 자동으로 바꾸지 않았습니다. 표시값이 같던 기존 행도 후속 조건에 포함됩니다.");
        }
        function outputControls() {
            el("mark").parentNode.hidden = el("output-kind").value !== "mark";
            el("output-name").parentNode.hidden = !!el("destination").value;
        }
        function settingsChanged() { invalidate(); resetSelection(); el("work").hidden = true; lastOutput = null; }
        el("saved").addEventListener("change", function () {
            var saved = (workspace.group_reviews || []).find(function (r) { return r.id === el("saved").value; });
            if (!saved) return;
            if (saved.column_ids.some(function (id) { return !workspace.columns.some(function (c) { return String(c.column_id) === id; }); })) { status("저장된 기준 열이 삭제되었습니다. 남아 있는 열로 새 기준을 선택하세요."); return; }
            el("column").value = saved.column_ids[0];
            refs.forEach(function (ref) { ref.input.checked = saved.column_ids.slice(1).includes(ref.id); });
            settingsChanged(); status("저장된 열 구성을 선택했습니다. 현재 값을 불러오면 변경된 묶음만 재검토 표시합니다.");
        });
        el("column").addEventListener("change", settingsChanged); el("scope").addEventListener("change", settingsChanged);
        el("query").addEventListener("input", function () { base = null; el("candidates").textContent = ""; });
        el("search").addEventListener("input", renderValues);
        el("load").addEventListener("click", function () { return run(load); });
        el("compare").addEventListener("click", function () { return run(compare); });
        el("clear").addEventListener("click", function () { resetSelection(); renderValues(); });
        el("save").addEventListener("click", function () { return run(async function () {
            var snapshot = await read(review.column_ids), byId = new Map(snapshot.rows.map(function (row) { return [row.identity, row]; }));
            var members = selectedItems();
            if (model.changed({members: members}, byId, review.column_ids.length)) throw new Error("선택한 값이 바뀌었습니다. 현재 값을 다시 불러오고 선택하세요.");
            var next = JSON.parse(JSON.stringify(review)), group = model.group(next, members, el("name").value, editing || options.api.newRequestId());
            next.groups = next.groups.filter(function (g) { return g.id !== group.id; }).concat(group);
            await commit(next); resetSelection(); renderValues(); renderGroups(); status("검토 중인 묶음으로 저장했습니다. 셀은 변경하지 않았습니다.");
        }); });
        el("reset-rejected").addEventListener("click", function () { return run(async function () {
            var next = JSON.parse(JSON.stringify(review)); next.rejected = []; await commit(next); el("candidates").textContent = ""; status("이 열 구성의 ‘다른 대상’ 판단을 지웠습니다. 필요하면 다시 비교하세요.");
        }); });
        el("output-open").addEventListener("click", function () { el("output").hidden = false; outputControls(); invalidate(); });
        ["destination", "output-kind", "mark", "output-name"].forEach(function (id) { el(id).addEventListener("change", function () { invalidate(); outputControls(); }); el(id).addEventListener("input", invalidate); });
        el("preview").addEventListener("click", function () { return run(buildPreview); });
        el("apply").addEventListener("click", function () { return run(apply); });
        el("filter").addEventListener("click", function () { return run(async function () {
            if (!lastOutput) throw new Error("먼저 조사 대상 표시값을 반영하세요.");
            await options.setFilter({column_id: lastOutput.column_id, operator: "equals", value: lastOutput.value});
            status("방금 표시한 값과 같은 행을 후속 작업 범위로 설정했습니다. 범위를 넓힐 때는 ‘작업표 전체’로 후보를 불러오세요.");
        }); });
        return {
            open: async function (columnId, request) {
                workspace = null; var input = await current();
                selectOptions("saved", (workspace.group_reviews || []).map(function (r) {
                    return {column_id: r.id, header: r.column_ids.map(function (id) {
                        var column = workspace.columns.find(function (c) { return String(c.column_id) === id; });
                        return column ? column.header : "삭제된 열";
                    }).join(" + ") + " · " + r.groups.length + "개 묶음"};
                }), "직접 열 선택");
                selectOptions("column", workspace.columns); if (columnId) el("column").value = columnId;
                el("references").textContent = "";
                refs = workspace.columns.map(function (c) { var id = String(c.column_id); return {id: id, input: choice(el("references"), c.header, false, settingsChanged)}; });
                request = request || {};
                el("query").value = request.match_text || "";
                el("comparison").open = !!request.match_text;
                el("output-kind").value = request.assigned_value != null ? "mark" : "name";
                el("mark").value = request.assigned_value != null ? request.assigned_value : "Y";
                el("output-name").value = request.output_name || "검토 묶음";
                settingsChanged(); el("scope").value = "all"; el("panel").hidden = false; status("묶을 열과 참고 열을 고르고 현재 값을 불러오세요. 공급자·모델 작업 순서는 자유입니다.");
            },
            dismiss: function () { invalidate(); el("panel").hidden = true; },
            busy: busy
        };
    };
})();
