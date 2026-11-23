"use strict";
(function () {
    window.createAgentController = function (options) {
        var api = options.api, chat = options.chat, current = null, pending = null;
        var attached = false, shown = new Set(), pendingSend = null, writeVerification = null;
        var notice = document.getElementById("notice");
        function path(id) {
            return "/conversations/" + encodeURIComponent(chat.getConversationId()) + "/agent-runs" + (id ? "/" + encodeURIComponent(id) : "");
        }
        function post(url, body, signal) {
            return api.requestJson(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: signal});
        }
        function progress(label, done, total) { notice.textContent = label + " · " + done + "/" + total + "행"; }
        function displayResult(observation, workspace) {
            if (!observation || !["read", "similarity"].includes(observation.kind)) return;
            var key = JSON.stringify(observation);
            if (shown.has(key)) return;
            shown.add(key);
            var rows = observation.groups || observation.rows || [], offset = 0;
            var bubble = document.createElement("article"); bubble.className = "chat-message assistant";
            var details = document.createElement("details"), summary = document.createElement("summary");
            details.className = "message-body markdown-body";
            summary.textContent = "실행 결과 · " + observation.row_count + "행 · " + rows.length + (observation.kind === "read" ? "개 값 조합" : "쌍 비교");
            var table = document.createElement("table"), label = document.createElement("span");
            var previous = document.createElement("button"), next = document.createElement("button");
            previous.type = next.type = "button"; previous.textContent = "이전"; next.textContent = "다음";
            if (window.operationsSheet) summary.textContent += " · " + workspace.sheet_name + " · " +
                window.operationsSheet.describeFilter(observation.row_filter, workspace.columns) +
                (observation.condition ? " · 추가 조건: " + window.operationsSheet.describeFilter(observation.condition, workspace.columns) : "");
            var headers = observation.kind === "read" ? observation.column_ids.map(function (id) {
                var col = workspace.columns.find(function (c) { return c.column_id === id; }); return col ? col.header : id;
            }).concat(["건수", "첫 Excel 행"]) : ["기준", "후보", "점수", "기준 건수", "후보 건수", "그룹", "기준 첫 행", "후보 첫 행"];
            function render() {
                table.replaceChildren();
                var head = document.createElement("tr");
                headers.forEach(function (text) { var cell = document.createElement("th"); cell.textContent = text; cell.setAttribute("scope", "col"); head.appendChild(cell); });
                table.appendChild(head);
                rows.slice(offset, offset + 100).forEach(function (row) {
                    var tr = document.createElement("tr");
                    var values = observation.kind === "read" ? row.values.concat([row.count, row.first_excel_row]) :
                        [row.base, row.candidate, row.score, row.base_count, row.candidate_count, row.group, row.base_row, row.candidate_row];
                    values.forEach(function (value) { var cell = document.createElement("td"); cell.textContent = String(value); tr.appendChild(cell); });
                    table.appendChild(tr);
                });
                label.textContent = rows.length ? (offset + 1) + "–" + Math.min(rows.length, offset + 100) + " / " + rows.length : "결과 없음";
                previous.disabled = offset === 0; next.disabled = offset + 100 >= rows.length;
            }
            previous.addEventListener("click", function () { offset = Math.max(0, offset - 100); render(); });
            next.addEventListener("click", function () { offset += 100; render(); });
            details.appendChild(summary); details.appendChild(table); details.appendChild(previous); details.appendChild(label); details.appendChild(next);
            bubble.appendChild(details); document.getElementById("conversation").appendChild(bubble); render();
        }
        async function pause(message) {
            attached = false; pending = null;
            if (current && !["CANCELLED", "UNKNOWN", "COMPLETED"].includes(current.status)) {
                try { current = await post(path(current.run_id) + "/pause", {message: message || ""}); }
                catch (error) { notice.textContent = "화면의 자동 진행은 멈췄지만 서버 상태는 확인하지 못했습니다. " + error.message; }
            }
        }
        async function drive(action, request, receipt) {
            attached = true;
            var verify = null;
            var id = action.run_id;
            var origin = request.request && request.request.request_id;
            // Retain an unsent result in this pane; retrying only resends the receipt, never a write.
            if (pendingSend && (pendingSend.run_id !== id || pendingSend.origin !== origin)) pendingSend = null;
            try {
                while (true) {
                    chat.checkRequest(request);
                    if (options.beforeRead) await options.beforeRead();
                    chat.checkRequest(request);
                    if (!pendingSend) {
                        pendingSend = {run_id: id, origin: origin, verify: verify, body: {request_id: api.newRequestId(),
                            workspace: await options.getWorkspace().context(), receipt: receipt || null}};
                    }
                    chat.checkRequest(request);
                    request.request = {conversation_id: chat.getConversationId(), request_id: pendingSend.body.request_id};
                    notice.textContent = "조사 · 현재 범위와 다음 행동 확인 중…";
                    var state = await post(path(id) + "/advance", pendingSend.body, request.controller.signal);
                    chat.checkRequest(request);
                    verify = pendingSend.verify || verify;
                    pendingSend = null;
                    current = state;
                    if (verify) await verify();
                    chat.checkRequest(request);
                    displayResult(state.observation, state.workspace);
                    notice.textContent = state.answer;
                    if (state.status !== "WAITING_EXCEL") {
                        var handoff = state.status === "WAITING_USER" && state.step && !state.step.job ? state.step.action : null;
                        writeVerification = handoff && handoff.auto_apply ? verify : null;
                        return {answer: state.answer, ui_action: handoff || null, origin_request_id: state.origin_request_id || null};
                    }
                    var step = state.step;
                    receipt = {step_id: step.step_id, status: "SUCCEEDED"};
                    if (step.action.type === "agent_read") {
                        var result = await window.readAgentData(options.getWorkspace().agentInput,
                            state.workspace, step.action.read, progress, function () { chat.checkRequest(request); });
                        receipt.rows = result.rows;
                        verify = (function (previous, latest) {
                            return async function () { if (previous) await previous(); await latest(); };
                        })(verify, result.verify);
                    } else if (step.action.type === "change_scope") {
                        chat.checkRequest(request);
                        receipt.message = await options.getWorkspace().changeScope(step.action.request, Object.assign({}, step.action, {origin_request_id: step.origin_request_id || origin}), function () { chat.checkRequest(request); });
                        verify = null;
                    } else throw new Error("지원하지 않는 조사 실행입니다.");
                }
            } catch (error) {
                if (request.cancelled) { pendingSend = null; attached = false; throw error; }
                // A changed sheet must invalidate even a just-completed model answer.
                if (!pendingSend) {
                    var detail = String(error.message || error).slice(0, 8000);
                    try {
                        if (current && current.status === "WAITING_EXCEL" && current.step) {
                            current = await post(path(id) + "/advance", {request_id: api.newRequestId(), workspace: current.workspace,
                                receipt: {step_id: current.step.step_id, status: "FAILED", message: detail}});
                            attached = false;
                        } else await pause(detail);
                    } catch (_) { attached = false; }
                }
                throw error;
            }
        }
        async function bind(kind, jobId) {
            if (!attached || !current || current.status !== "WAITING_USER" || !current.step) return;
            current = await post(path(current.run_id) + "/bind", {step_id: current.step.step_id, kind: kind, job_id: jobId});
        }
        function complete(outcome, text) {
            if (!attached || !current || !current.step || !current.step.job || current.step.job.job_id !== outcome.job_id) return;
            pending = {run_id: current.run_id, receipt: {step_id: current.step.step_id, status: outcome.status, message: text}};
        }
        function flush() {
            if (!pending || chat.isBusy()) return;
            var saved = pending; pending = null;
            // Controllers finish their own finally blocks before starting the next request.
            window.setTimeout(async function () {
                if (!attached || chat.isBusy() || !current || current.run_id !== saved.run_id) { if (attached) pending = saved; return; }
                var request = chat.beginRequest(); chat.setBusy(true);
                try {
                    var reply = await drive({run_id: saved.run_id}, request, saved.receipt);
                    chat.checkRequest(request);
                    // The task controller already displayed this failure before sending its receipt.
                    var reportedFailure = saved.receipt.status !== "SUCCEEDED" && ["FAILED", "UNKNOWN"].includes(current.status) &&
                        reply.answer === saved.receipt.message;
                    if (!reportedFailure) chat.appendMessage("assistant", reply.answer);
                    chat.setBusy(false);
                    await options.handleUIAction(reply.ui_action, current.goal, reply.origin_request_id);
                } catch (error) {
                    if (request.cancelled) { await chat.reportStop(request); chat.appendMessage("assistant", "조사 실행을 중지했습니다."); }
                    else chat.appendMessage("assistant", error.message);
                } finally { chat.endRequest(request); chat.setBusy(false); }
            }, 0);
        }
        return {
            run: drive, bind: bind, complete: complete, flush: flush, pause: pause,
            verifyWrite: async function () {
                if (!attached || !current || !current.step || !current.step.action.auto_apply || !writeVerification) {
                    throw new Error("대표 부호의 최신 조회를 확인할 수 없습니다. 다시 요청하세요.");
                }
                await writeVerification();
                if (!attached) throw new Error("그룹 연결을 중지했습니다.");
            },
            detach: function () { attached = false; pending = null; pendingSend = null; },
            load: async function () {
                attached = false; pending = pendingSend = null; shown.clear();
                current = (await api.requestJson(path(), {cache: "no-store"})).run;
                if (current) {
                    displayResult(current.observation, current.workspace);
                    notice.textContent = current.status + " · " + current.answer + " 이어가려면 채팅으로 요청하세요.";
                }
            }
        };
    };
})();
