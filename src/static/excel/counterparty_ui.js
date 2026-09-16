"use strict";

(function () {
    window.createCounterpartyUI = function (chat) {
        var panel = document.getElementById("counterparty-panel");
        var mapping = document.getElementById("party-mapping");
        var source = document.getElementById("party-source");
        var preview = document.getElementById("party-preview");
        var status = document.getElementById("party-status");
        var candidates = document.getElementById("party-candidates");
        var selectButton = document.getElementById("party-select");
        var createButton = document.getElementById("party-create");
        var reviewButton = document.getElementById("party-review");
        var refreshButton = document.getElementById("party-refresh");
        var selects = ["party-code", "party-country", "party-name"].map(function (id) {
            return document.getElementById(id);
        });
        var roles = ["OVCS_SGN", "OVCS_NAT_CD", "OVCS_CONM"];

        function open() {
            chat.enterConversation();
            panel.hidden = false;
            if (!chat.conversation.contains(panel)) chat.conversation.appendChild(panel);
            chat.scrollArea.scrollTop = chat.scrollArea.scrollHeight;
        }
        function reset() {
            panel.hidden = true;
            chat.scrollArea.appendChild(panel);
            mapping.hidden = candidates.hidden = true;
            source.textContent = preview.textContent = status.textContent = candidates.textContent = "";
        }
        function beginSelection() {
            open();
            mapping.hidden = candidates.hidden = true;
            refreshButton.disabled = reviewButton.disabled = true;
        }
        function showSelection(selection) {
            selects.forEach(function (select, role) {
                select.textContent = "";
                selection.headers.forEach(function (header, index) {
                    var option = document.createElement("option");
                    option.value = String(index);
                    option.textContent = (index + 1) + "번째 열 · " + (header || "(머리글 없음)");
                    select.appendChild(option);
                });
                var found = selection.headers.findIndex(function (header) {
                    return header.trim().toUpperCase() === roles[role];
                });
                select.value = String(found >= 0 ? found : role);
            });
            source.textContent = selection.address + " · 데이터 " + selection.rows.length + "행";
            preview.textContent = [selection.headers.join(" | ")].concat(
                selection.rows.slice(0, 20).map(function (row) { return row.cells.join(" | "); })
            ).join("\n");
            mapping.hidden = false;
            status.textContent = "부호·국가·상호 열을 확인하세요.";
        }
        function format(group, reviewed) {
            var decision = {
                SAME_HIGH_CONFIDENCE: "동일 가능성 높음",
                NEEDS_REVIEW: "추가 확인 필요"
            }[group.decision];
            return "[" + group.group_id + "] 국가 " + group.country_code +
                " · 기존 부호 " + group.existing_party_codes.join(", ") + "\n" +
                group.rows.map(function (row) {
                    return row.excel_row + "행 · " + row.party_code + " · " + row.company_name;
                }).join("\n") + "\n" + (reviewed ? "모델 판단: " + decision + "\n" : "") +
                "근거: " + group.reason + (group.similarity ? " (유사도 " + group.similarity + ")" : "");
        }
        function renderJob(job) {
            var reviewed = job.status === "REVIEW_READY";
            var groups = reviewed ? job.final_candidates : job.candidate_groups;
            candidates.textContent = groups.length
                ? groups.map(function (group) { return format(group, reviewed); }).join("\n\n")
                : (reviewed ? "사람이 확인할 최종 후보가 없습니다." : "현재 조건에 맞는 후보가 없습니다.");
            candidates.hidden = false;
            reviewButton.disabled = reviewed || !job.candidate_groups.length;
            refreshButton.disabled = false;
            status.textContent = job.error || (reviewed
                ? "모델 검토 완료 · 최종 후보 " + job.final_candidates.length +
                    "건 · 제외 " + job.excluded_candidate_count + "건\n승인과 부호 반영은 아직 하지 않았습니다."
                : "후보 " + job.candidate_groups.length + "건 · 같은 국가끼리만 비교했습니다.");
        }
        return {
            open: open, reset: reset, beginSelection: beginSelection,
            showSelection: showSelection, renderJob: renderJob,
            setStatus: function (text) { status.textContent = text; },
            getMapping: function () { return selects.map(function (item) { return Number(item.value); }); },
            setBusy: function (busy, hasPayload, canReview) {
                selectButton.disabled = busy;
                createButton.disabled = busy;
                refreshButton.disabled = busy || !hasPayload;
                reviewButton.disabled = busy || !hasPayload || !canReview;
                selects.forEach(function (item) { item.disabled = busy; });
            },
            bind: function (handlers) {
                selectButton.addEventListener("click", handlers.select);
                createButton.addEventListener("click", handlers.create);
                reviewButton.addEventListener("click", handlers.review);
                refreshButton.addEventListener("click", handlers.refresh);
                selects.forEach(function (item) { item.addEventListener("change", handlers.mappingChange); });
            }
        };
    };
})();
