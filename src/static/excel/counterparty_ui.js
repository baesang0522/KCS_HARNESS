"use strict";

(function () {
    window.createCounterpartyUI = function (chat) {
        var panel = document.getElementById("counterparty-panel");
        var mapping = document.getElementById("party-mapping");
        var source = document.getElementById("party-source");
        var preview = document.getElementById("party-preview");
        var status = document.getElementById("party-status");
        var candidates = document.getElementById("party-candidates");
        var approvalResult = document.getElementById("party-approval-result");
        var selectButton = document.getElementById("party-select");
        var createButton = document.getElementById("party-create");
        var reviewButton = document.getElementById("party-review");
        var previewButton = document.getElementById("party-approval-preview");
        var exportButton = document.getElementById("party-export");
        var refreshButton = document.getElementById("party-refresh");
        var policyCurrent = document.getElementById("party-policy-current");
        var policyRequest = document.getElementById("party-policy-request");
        var policySuggestButton = document.getElementById("party-policy-suggest");
        var policyDraft = document.getElementById("party-policy-draft");
        var policyDraftText = document.getElementById("party-policy-draft-text");
        var policyApplyButton = document.getElementById("party-policy-apply");
        var selects = ["party-code", "party-country", "party-name"].map(function (id) {
            return document.getElementById(id);
        });
        var roles = ["OVCS_SGN", "OVCS_NAT_CD", "OVCS_CONM"];
        var previewHasRows = false;

        function open() {
            chat.enterConversation();
            panel.hidden = false;
            if (!chat.conversation.contains(panel)) chat.conversation.appendChild(panel);
            chat.scrollArea.scrollTop = chat.scrollArea.scrollHeight;
        }
        function clearApprovalPreview() {
            approvalResult.hidden = true;
            approvalResult.textContent = "";
            previewHasRows = false;
            exportButton.disabled = true;
            exportButton.textContent = "전체 정제 결과를 새 시트에 생성";
        }
        function formatPolicy(policy) {
            return "유사도 " + Math.round(policy.similarity_threshold * 100) + "% 이상" +
                " · 무시할 단어 " + (policy.ignored_terms.length ? policy.ignored_terms.join(", ") : "없음") +
                " · 같은 국가코드만 비교";
        }
        function clearPolicySuggestion() {
            policyDraft.hidden = true;
            policyDraftText.textContent = "";
        }
        function reset() {
            panel.hidden = true;
            chat.scrollArea.appendChild(panel);
            mapping.hidden = candidates.hidden = true;
            source.textContent = preview.textContent = status.textContent = candidates.textContent = "";
            policyCurrent.textContent = "기본 기준 · 유사도 90% 이상 · 같은 국가코드만 비교";
            policyRequest.value = "";
            clearPolicySuggestion();
            clearApprovalPreview();
        }
        function beginSelection() {
            open();
            mapping.hidden = candidates.hidden = true;
            refreshButton.disabled = reviewButton.disabled = previewButton.disabled = true;
            clearApprovalPreview();
            clearPolicySuggestion();
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
        function format(group, reviewed, index) {
            var decision = {SAME_HIGH_CONFIDENCE: "동일 가능성 높음", NEEDS_REVIEW: "추가 확인 필요"}[group.decision];
            return "후보 " + (index + 1) + " · [" + group.group_id + "]\n국가 " + group.country_code +
                " · 기존 부호 " + group.existing_party_codes.join(", ") + "\n" +
                group.rows.map(function (row) {
                    return row.excel_row + "행 · " + row.party_code + " · " + row.company_name;
                }).join("\n") + "\n" + (reviewed ? "모델 판단: " + decision + "\n" : "") +
                "근거: " + group.reason + (group.similarity ? " (유사도 " + group.similarity + ")" : "");
        }
        function renderCandidate(group, index) {
            var card = document.createElement("section");
            card.className = "party-candidate";
            card.dataset.groupId = group.group_id;
            var text = document.createElement("pre");
            text.textContent = format(group, true, index);
            card.appendChild(text);
            var approvalLabel = document.createElement("label");
            var approval = document.createElement("input");
            approval.type = "checkbox";
            approval.className = "party-approve";
            approvalLabel.appendChild(approval);
            approvalLabel.appendChild(document.createTextNode(" 이 그룹을 같은 거래처로 승인"));
            card.appendChild(approvalLabel);
            var codeLabel = document.createElement("label");
            codeLabel.appendChild(document.createTextNode("대표 해외거래처부호 "));
            var code = document.createElement("select");
            code.className = "party-representative";
            code.disabled = true;
            var empty = document.createElement("option");
            empty.value = "";
            empty.textContent = "대표 부호 선택";
            code.appendChild(empty);
            group.existing_party_codes.forEach(function (value) {
                var option = document.createElement("option");
                option.value = value;
                option.textContent = value;
                code.appendChild(option);
            });
            codeLabel.appendChild(code);
            card.appendChild(codeLabel);
            candidates.appendChild(card);
        }
        function renderJob(job) {
            var reviewed = job.status === "REVIEW_READY";
            var groups = reviewed ? job.final_candidates : job.candidate_groups;
            candidates.textContent = "";
            if (reviewed && groups.length) {
                groups.forEach(renderCandidate);
            } else {
                var text = document.createElement("pre");
                text.textContent = groups.length
                    ? "문자열 검토 후보 " + groups.length + "건\n\n" + groups.map(function (group, index) {
                        return format(group, false, index);
                    }).join("\n\n────────────────────\n\n")
                    : (reviewed ? "사람이 확인할 최종 후보가 없습니다." : "현재 조건에 맞는 후보가 없습니다.");
                candidates.appendChild(text);
            }
            candidates.hidden = false;
            policyCurrent.textContent = "현재 기준 · " + formatPolicy(job.policy);
            reviewButton.disabled = reviewed || !job.candidate_groups.length;
            previewButton.disabled = !reviewed || !groups.length;
            refreshButton.disabled = false;
            var missingLabels = {party_code: "부호", country_code: "국가", company_name: "상호"};
            var missing = Object.keys(job.missing_counts).filter(function (role) {
                return job.missing_counts[role] > 0;
            }).map(function (role) {
                return missingLabels[role] + " " + job.missing_counts[role] + "행";
            });
            status.textContent = job.error || ((reviewed
                ? "모델 검토 완료 · 최종 후보 " + job.final_candidates.length +
                    "건 · 제외 " + job.excluded_candidate_count +
                    "건\n승인할 그룹을 체크하고 대표 부호를 선택하세요. 체크하지 않은 그룹은 제외됩니다."
                : "후보 " + job.candidate_groups.length + "건 · 같은 국가끼리만 비교했습니다.") +
                (missing.length ? "\n누락 데이터 · " + missing.join(", ") : ""));
            if (reviewed && groups.length) candidates.scrollIntoView({block: "start"});
        }
        function getDecisions() {
            return Array.from(candidates.querySelectorAll(".party-candidate")).map(function (card) {
                var approved = card.querySelector(".party-approve").checked;
                var representative = card.querySelector(".party-representative").value;
                if (approved && !representative) throw new Error(card.dataset.groupId + "의 대표 부호를 선택하세요.");
                return {
                    group_id: card.dataset.groupId,
                    decision: approved ? "APPROVE" : "EXCLUDE",
                    representative_party_code: approved ? representative : null
                };
            });
        }
        function showApprovalPreview(data) {
            var changedRows = data.rows.filter(function (row) { return row.changed; });
            previewHasRows = data.row_count > 0;
            approvalResult.hidden = false;
            approvalResult.textContent =
                "승인 " + data.approved_group_count + "그룹 · 제외 " +
                data.excluded_group_count + "그룹 · " + data.changed_count + "행 변경\n\n" +
                (changedRows.length ? changedRows.slice(0, 100).map(function (row) {
                    return row.excel_row + "행 · " + row.company_name + "\n전: " +
                        row.original_party_code + "\n후: " + row.representative_party_code;
                }).join("\n\n") + (changedRows.length > 100 ? "\n\n외 " + (changedRows.length - 100) + "행" : "")
                    : "부호가 변경되는 행은 없습니다.");
            exportButton.disabled = !previewHasRows;
            status.textContent = previewHasRows
                ? "전체 " + data.row_count + "행 중 변경 " + data.changed_count + "행입니다. 확인 후 새 시트를 생성하세요."
                : "모든 후보를 제외했습니다.";
        }
        return {
            open: open, reset: reset, beginSelection: beginSelection,
            showSelection: showSelection, renderJob: renderJob,
            clearApprovalPreview: clearApprovalPreview, getDecisions: getDecisions,
            showApprovalPreview: showApprovalPreview,
            clearCandidates: function () {
                candidates.hidden = true;
                candidates.textContent = "";
                clearApprovalPreview();
            },
            getPolicyInstruction: function () { return policyRequest.value.trim(); },
            setPolicyInstruction: function (value) { policyRequest.value = value; },
            clearPolicySuggestion: clearPolicySuggestion,
            showPolicySuggestion: function (suggestion) {
                policyDraft.hidden = false;
                policyDraftText.textContent = "제안 기준 · " + formatPolicy(suggestion.policy) +
                    "\n근거 · " + suggestion.reason;
            },
            getDecisionState: function () {
                return Array.from(candidates.querySelectorAll(".party-candidate")).map(function (card) {
                    return {
                        group_id: card.dataset.groupId,
                        approved: card.querySelector(".party-approve").checked,
                        representative: card.querySelector(".party-representative").value
                    };
                });
            },
            restoreDecisionState: function (states) {
                states.forEach(function (state) {
                    var card = candidates.querySelector('[data-group-id="' + state.group_id + '"]');
                    if (!card) return;
                    var approval = card.querySelector(".party-approve");
                    var representative = card.querySelector(".party-representative");
                    approval.checked = state.approved;
                    representative.disabled = !state.approved;
                    representative.value = state.representative;
                });
            },
            setExported: function (result) {
                exportButton.disabled = true;
                exportButton.textContent = result.sheet_name + " · " + result.row_count + "행 반영 완료";
            },
            setStatus: function (text) { status.textContent = text; },
            getMapping: function () { return selects.map(function (item) { return Number(item.value); }); },
            setBusy: function (busy, hasPayload, canReview, canApprove, hasPreview, exported, hasPolicyDraft) {
                selectButton.disabled = busy;
                createButton.disabled = busy;
                refreshButton.disabled = busy || !hasPayload;
                reviewButton.disabled = busy || !hasPayload || !canReview;
                previewButton.disabled = busy || !canApprove;
                exportButton.disabled = busy || !hasPreview || exported || !previewHasRows;
                policySuggestButton.disabled = busy;
                policyApplyButton.disabled = busy || !hasPolicyDraft;
                selects.forEach(function (item) { item.disabled = busy; });
            },
            bind: function (handlers) {
                selectButton.addEventListener("click", handlers.select);
                createButton.addEventListener("click", handlers.create);
                reviewButton.addEventListener("click", handlers.review);
                previewButton.addEventListener("click", handlers.preview);
                exportButton.addEventListener("click", handlers.export);
                refreshButton.addEventListener("click", handlers.refresh);
                policySuggestButton.addEventListener("click", handlers.suggestPolicy);
                policyApplyButton.addEventListener("click", handlers.applyPolicy);
                candidates.addEventListener("change", function (event) {
                    if (event.target.classList.contains("party-approve")) {
                        event.target.closest(".party-candidate")
                            .querySelector(".party-representative").disabled = !event.target.checked;
                    }
                    handlers.decisionChange();
                });
                selects.forEach(function (item) { item.addEventListener("change", handlers.mappingChange); });
            }
        };
    };
})();
