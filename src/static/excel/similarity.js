"use strict";
(function () {
    window.createSimilarityController = function (options) {
        function el(id) { return document.getElementById("sim-" + id); }
        function progress(label, done, total) {
            options.status(label + " · " + done.toLocaleString() + "/" + total.toLocaleString());
        }
        function updateRun() {
            el("run").disabled = options.isBusy() || !["sequence", "levenshtein"].includes(el("method").value);
        }
        function reset() {
            el("panel").hidden = true;
            el("method").value = "";
            updateRun();
            document.getElementById("operations").hidden = false;
        }
        function describe() {
            updateRun();
            if (!el("method").value) {
                el("description").textContent = "설명과 샘플을 확인하고 비교 방식을 선택하세요.";
                return;
            }
            el("description").textContent = el("method").value === "sequence"
                ? "같은 순서로 이어지는 문자열 부분을 비교합니다. 비교 방향에 따른 차이를 줄이기 위해 양방향 점수의 평균을 사용합니다."
                : "글자 추가·삭제·교체 횟수를 문자열 길이에 맞춰 0~100점으로 계산합니다. 작은 철자 차이를 찾는 데 사용합니다.";
        }
        function show(workspace, target, settings) {
            var ids = [settings.column_id].concat(settings.group_column_id ? [settings.group_column_id] : []);
            if (ids.some(function (id) { return !workspace.columns.some(function (c) { return String(c.column_id) === id; }); })) {
                throw new Error("유사도 검사 대상 열이 없습니다. 다시 요청하세요.");
            }
            el("column").replaceChildren();
            el("group").replaceChildren(new Option("제한 없음", ""));
            workspace.columns.forEach(function (column) {
                el("column").add(new Option(column.header, String(column.column_id)));
                el("group").add(new Option(column.header, String(column.column_id)));
            });
            el("column").value = settings.column_id;
            el("group").value = settings.group_column_id || "";
            el("method").value = "";
            el("scope").textContent = workspace.sheet_name + " · 현재 범위 " + target.row_count.toLocaleString() + "행. 숨긴 행도 포함합니다.";
            document.getElementById("operations").hidden = true;
            el("panel").hidden = false;
            describe();
        }
        el("method").addEventListener("change", describe);
        el("back").addEventListener("click", function () { if (!options.isBusy()) reset(); });
        el("run").addEventListener("click", async function () {
            if (options.isBusy()) return;
            if (!["sequence", "levenshtein"].includes(el("method").value)) { options.status("비교 방식을 선택해 주세요."); return; }
            var settings = {
                column_id: el("column").value,
                group_column_id: el("group").value || null,
                method: el("method").value
            };
            if (settings.column_id === settings.group_column_id) { options.status("검사 대상과 비교 조건에는 다른 열을 선택하세요."); return; }
            options.setBusy(true);
            try {
                var current = await options.getInput();
                var ids = [settings.column_id].concat(settings.group_column_id ? [settings.group_column_id] : []);
                var snapshot = await window.operationsSheet.read(current.workspace, current.target, ids, progress, function () {});
                var capturedAt = new Date().toISOString();
                options.status("유사도 계산 중입니다. 검사 완료까지 작업 시트를 편집·정렬하지 마세요.");
                var result = await options.api.requestJson("/operations/similarity", {
                    method: "POST", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({settings: settings, rows: snapshot.rows.map(function (row) {
                        return {excel_row: row.excel_row, value: row.values[0], group: settings.group_column_id ? row.values[1] : ""};
                    })})
                });
                current = await options.getInput();
                var latest = await window.operationsSheet.read(current.workspace, current.target, ids, progress, function () {});
                if (snapshot.stamp !== latest.stamp || JSON.stringify(snapshot.rows) !== JSON.stringify(latest.rows)) {
                    throw new Error("검사 중 값이나 표 구성이 바뀌었습니다. 다시 검사하세요.");
                }
                snapshot.workspace.sheet_name = latest.workspace.sheet_name;
                var name = await window.similaritySheet.write(snapshot, result, settings, capturedAt, options.api.newRequestId(), progress);
                reset();
                options.complete("유사도 검사 결과 " + result.rows.length.toLocaleString() + "쌍을 ‘" + name + "’ 시트에 작성했습니다. " +
                    "원본 데이터는 변경하지 않았습니다.");
            } catch (error) { options.status(error.message); }
            finally { options.setBusy(false); }
        });
        return {show: show, reset: reset, busy: updateRun};
    };
})();
