"use strict";
(function () {
    async function digest(values) {
        var hash = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
        return Array.from(new Uint8Array(hash), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }
    async function readBlock(context, sheet, block, identityIndex) {
        var range = sheet.getRangeByIndexes(block.row_start, block.column_start, block.row_count, 1);
        range.load("values");
        var formulas = range.getSpecialCellsOrNullObject("Formulas");
        var identities = identityIndex == null ? null : sheet.getRangeByIndexes(block.row_start, identityIndex, block.row_count, 1);
        if (identities) identities.load("values");
        await context.sync();
        return {values: await digest(range.values), identities: identities ? await digest(identities.values) : null, formulas: !formulas.isNullObject};
    }
    async function capture(context, sheet, tableInfo, targets, expected) {
        sheet.load("id"); if (tableInfo) tableInfo.table.load("id"); await context.sync();
        var evidence = {worksheet_id: sheet.id, table_id: tableInfo ? String(tableInfo.table.id) : null,
            identity_column_id: tableInfo ? String(tableInfo.identity.column_id) : null, blocks: []};
        for (var target of targets) for (var offset = 0; offset < target.row_count; offset += 1000) {
            var block = {row_start: target.row_start + offset, row_count: Math.min(1000, target.row_count - offset),
                column_start: target.column_start, column_id: target.column_id || null};
            var current = await readBlock(context, sheet, block, tableInfo && tableInfo.identity.column_index);
            if (current.formulas) throw new Error("쓰기 전에 결과 범위의 수식을 확인하세요.");
            block.before = current.values; block.identities = current.identities;
            block.expected = expected ? await digest(expected(block)) : null;
            evidence.blocks.push(block);
        }
        return evidence;
    }
    async function observe(evidence) {
        return Excel.run(async function (context) {
            var sheet = context.workbook.worksheets.getItem(evidence.worksheet_id), info = null;
            if (evidence.table_id) info = await window.workspaceTable.layout(context, {
                worksheet_id: evidence.worksheet_id, table_id: evidence.table_id, source_row_column_id: evidence.identity_column_id});
            var result = {values: [], identities: [], formulas: []};
            for (var block of evidence.blocks) {
                if (info && (!info.columns.some(function (column) { return String(column.column_id) === block.column_id && column.column_index === block.column_start; }) ||
                    block.row_start < info.body.rowIndex || block.row_start + block.row_count > info.body.rowIndex + info.body.rowCount)) {
                    throw new Error("결과 열 위치나 행 범위가 바뀌었습니다. 직접 확인한 내용을 기록하세요.");
                }
                var current = await readBlock(context, sheet, block, info && info.identity.column_index);
                result.values.push(current.values); result.identities.push(current.identities); result.formulas.push(current.formulas);
            }
            if (info && (await window.workspaceTable.layout(context, {worksheet_id: evidence.worksheet_id, table_id: evidence.table_id,
                source_row_column_id: evidence.identity_column_id})).stamp !== info.stamp) throw new Error("확인 중 작업표가 바뀌었습니다. 다시 확인하세요.");
            return result;
        });
    }
    window.writeRecoverySheet = {digest: digest, capture: capture, observe: observe, readBlock: readBlock};
    window.createWriteRecovery = function (options) {
        var panel = document.createElement("div"), pending = new Map(), generation = 0, attached = false;
        function path(kind, id, action, cid) { return "/write-recovery/" + kind + "/" + encodeURIComponent(id) + "/" + action +
            "?conversation_id=" + encodeURIComponent(cid || options.getConversationId()); }
        function request(kind, id, action, data, method, cid) {
            return options.api.requestJson(path(kind, id, action, cid), {method: method || "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
        }
        async function save(kind, id, evidence) {
            await request(kind, id, "evidence", evidence, "PUT"); pending.set(id, pending.get(id) || null);
        }
        async function refresh() {
            var cid = options.getConversationId(); if (!cid) return;
            var version = ++generation;
            try {
                var workspace = options.getWorkspace();
                var query = workspace ? "&worksheet_id=" + encodeURIComponent(workspace.worksheet_id) + "&table_id=" + encodeURIComponent(workspace.table_id) : "";
                pending.forEach(function (_, id) { query += "&job_id=" + encodeURIComponent(id); });
                var jobs = await options.api.requestJson("/write-recovery?conversation_id=" + encodeURIComponent(cid) + query);
                if (version !== generation || cid !== options.getConversationId()) return;
                jobs = jobs.filter(function (job) { return ["APPLYING", "UNKNOWN"].includes(job.status) || pending.has(job.job_id); });
                panel.textContent = ""; panel.hidden = !jobs.length;
                if (jobs.length && !attached) { options.messages.say("완료 여부를 확인할 쓰기가 있어. 기존 실행을 다시 쓰지 않고 현재 값을 대조할 수 있어.").appendChild(panel); attached = true; }
                for (var job of jobs) render(job);
            } catch (error) { if (version === generation) { panel.hidden = false; panel.textContent = "쓰기 기록 확인 실패 · " + error.message; options.messages.say(panel.textContent); } }
        }
        function render(job) {
            var card = document.createElement("section"), label = document.createElement("p"), check = document.createElement("button"), status = document.createElement("p");
            label.textContent = "쓰기 결과 확인 · " + (job.kind === "formula" ? "수식" : "정제") + " · " + job.job_id;
            if (job.evidence) {
                var scopes = new Map();
                job.evidence.blocks.forEach(function (b) {
                    var scope = scopes.get(b.column_start) || {first: b.row_start + 1, last: 0, count: 0};
                    scope.first = Math.min(scope.first, b.row_start + 1); scope.last = Math.max(scope.last, b.row_start + b.row_count); scope.count += b.row_count; scopes.set(b.column_start, scope);
                });
                label.textContent += " · " + Array.from(scopes, function (entry) { return (entry[0] + 1) + "번째 열 / " + entry[1].first + "–" + entry[1].last + "행 중 " + entry[1].count + "행"; }).join(", ");
            }
            check.type = "button"; check.textContent = "현재 값 대조";
            card.appendChild(label); card.appendChild(check); card.appendChild(status); panel.appendChild(card);
            var manual = document.createElement("div"), choice = {value: "unknown"}, note = {value: ""}, record = {disabled: false};
            card.appendChild(manual);
            [["unknown", "판단 불가"], ["partial", "일부 반영"], ["not_applied", "미반영 확인"], ["completed", "반영 완료 확인"]].forEach(function (item) {
                options.messages.button(manual, item[1] + " 기록", function () {
                    if (record.disabled) return;
                    options.messages.ask("직접 확인한 범위와 판단 근거를 채팅으로 적어 줘. 취소하려면 ‘취소’라고 입력해.", function (text) {
                        choice.value = item[0]; note.value = text;
                        options.messages.confirm(item[1] + "으로 기록할까?\n" + text, {apply: function () { return run(true); }, cancel: function () {}});
                    });
                });
            });
            var conversationId = options.getConversationId(), target = options.getWorkspace();
            async function run(user) {
                if (options.isBusy()) return;
                var current = options.getWorkspace();
                if (conversationId !== options.getConversationId() || target && (!current || target.worksheet_id !== current.worksheet_id || String(target.table_id) !== String(current.table_id))) throw new Error("조사나 작업표가 바뀌었어요. 쓰기 결과 확인을 다시 요청하세요.");
                options.setBusy(true); check.disabled = record.disabled = true;
                try {
                    var observation = {values: [], identities: [], formulas: []};
                    if (job.evidence) {
                        try { observation = await observe(job.evidence); }
                        catch (error) { if (!user) throw error; }
                    }
                    if (user) { observation.conclusion = choice.value; observation.note = note.value; }
                    var result = await request(job.kind, job.job_id, "check", observation, "POST", job.conversation_id);
                    var last = result.checks[result.checks.length - 1];
                    status.textContent = (last ? {completed: "완료 확인", not_applied: "미반영 확인", partial: "일부 반영", unknown: "판단 불가"}[last.result] : result.status) +
                        " · 셀은 변경하지 않았습니다.";
                    if (["APPLIED", "NOT_APPLIED"].includes(result.status)) {
                        if (result.status === "APPLIED") {
                            var restore = pending.get(job.job_id);
                            if (last && last.result !== "completed") {
                                status.textContent += " 기존 쓰기는 완료됐지만 현재 값 대조는 일치하지 않습니다. 결과 열을 재검토하세요.";
                                if (options.onRecovered) await options.onRecovered(result);
                            } else if (restore) await restore();
                            else if (options.onRecovered) await options.onRecovered(result);
                        }
                        pending.delete(job.job_id); check.disabled = record.disabled = true;
                        manual.hidden = true;
                        status.textContent += " 기존 실행을 다시 쓰지 않습니다.";
                    } else {
                        status.textContent += " 미확인 쓰기가 남아 후속 쓰기는 중단됩니다.";
                        check.disabled = record.disabled = false;
                    }
                } catch (error) { status.textContent = error.message; check.disabled = record.disabled = false; }
                finally { options.setBusy(false); }
            }
            check.addEventListener("click", function () { return run(false).catch(function (error) { status.textContent = error.message; }); });
        }
        return {
            refresh: refresh,
            reset: function () { generation++; pending.clear(); attached = false; panel = document.createElement("div"); panel.hidden = true; panel.textContent = ""; },
            completed: function (id) { pending.delete(id); },
            remember: function (id, restore) { pending.set(id, restore); },
            operation: async function (job, context, info, snapshot, outputs, values) {
                var targets = [];
                outputs.forEach(function (column) {
                    snapshot.rows.forEach(function (row, index) {
                        var last = targets[targets.length - 1];
                        if (index && last.column_id === String(column.column_id) && last.row_start + last.row_count === row.excel_row - 1) last.row_count++;
                        else targets.push({row_start: row.excel_row - 1, row_count: 1, column_start: column.column_index, column_id: String(column.column_id)});
                    });
                });
                var indexByRow = new Map(snapshot.rows.map(function (row, i) { return [row.excel_row - 1, i]; }));
                var evidence = await capture(context, info.sheet, info, targets, function (block) {
                    var column = outputs.findIndex(function (c) { return String(c.column_id) === block.column_id; });
                    return Array.from({length: block.row_count}, function (_, i) { return [values[indexByRow.get(block.row_start + i)][column]]; });
                });
                await save("operation", job.source.operation_job_id, evidence);
            },
            formula: function (id, selection, workspace) {
                var evidence;
                return async function (context, sheet, targets, calculated) {
                    if (!calculated) {
                        var info = workspace ? await window.workspaceTable.layout(context, workspace) : null;
                        var ranges = targets.map(function (target) {
                            var column = info && info.columns.find(function (c) { return c.column_index === target.columnIndex; });
                            return {row_start: target.rowIndex, row_count: target.rowCount, column_start: target.columnIndex, column_id: column ? String(column.column_id) : null};
                        });
                        evidence = await capture(context, sheet, info, ranges);
                    } else {
                        for (var block of evidence.blocks) {
                            var range = sheet.getRangeByIndexes(block.row_start, block.column_start, block.row_count, 1);
                            range.load("values"); await context.sync(); block.expected = await digest(range.values);
                        }
                    }
                    await save("formula", id, evidence);
                };
            }
        };
    };
})();
