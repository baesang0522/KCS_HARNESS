"use strict";

(function () {
    var selectButton = document.getElementById("norm-select");
    var analyzeButton = document.getElementById("norm-analyze");
    var refreshButton = document.getElementById("norm-refresh");
    var mappingPanel = document.getElementById("norm-mapping");
    var sourceText = document.getElementById("norm-source");
    var preview = document.getElementById("norm-preview");
    var statusText = document.getElementById("norm-status");
    var panel = document.getElementById("normalization-panel");
    var attachButton = document.getElementById("attach-range");
    var resultBubble = null;
    var resultText = null;
    var previewButton = null;
    var refreshing = false;

    function openPanel() {
        enterConversation();
        panel.hidden = false;
        if (!conversation.contains(panel)) conversation.appendChild(panel);
        scrollArea.scrollTop = scrollArea.scrollHeight;
    }

    function clearResult() {
    // 과거 범위의 결과는 남겨두되 다시 실행하지 못하게 한다.
        if (previewButton) {
            previewButton.disabled = true;
        }

        previewButton = null;
        resultBubble = null;
        resultText = null;
    }

    function archivePanel() {
        if (!selection) return;
        var summary = appendMessage('user',
            sourceText.textContent + '\n' +
            selects.map(function (select, index) {
                return ['거래품명', '신고품명', '모델규격'][index] + ': ' +
                    select.options[select.selectedIndex].textContent;
            }).join('\n'));
        summary.classList.add('range-summary');
        conversation.insertBefore(summary, panel);
    }

    window.normalizationUI = {open: openPanel};
    document.addEventListener('chat-reset', function () {
        panel.hidden = true;
        scrollArea.appendChild(panel);
        selection = null;
        payload = null;
        clearResult();
        mappingPanel.hidden = true;
        statusText.textContent = '';
        sourceText.textContent = '';
        preview.textContent = '';
        refreshButton.disabled = true;
        selectButton.textContent = '선택 범위 가져오기';
    });
    document.addEventListener('chat-busy', function (event) {
        selectButton.disabled = event.detail;
        analyzeButton.disabled = event.detail;
        refreshButton.disabled = event.detail || !payload;
        selects.forEach(function (select) { select.disabled = event.detail; });
        // 미리보기 버튼이 만들어져 있으면 함께 활성화/비활성화 함
        if (previewButton) {
        previewButton.disabled = event.detail;
        }
    });

    attachButton.addEventListener('click', function () {
        if (sending || workflowBusy) return;
        openPanel();
        selectButton.click();
    });

    var selects = [
        document.getElementById("norm-trade"),
        document.getElementById("norm-declared"),
        document.getElementById("norm-spec")
    ];

    var selection = null;
    var payload = null;

    function setBusy(value) {
        workflowBusy = value;
        window.setBusy(value);
        selectButton.disabled = value;
        analyzeButton.disabled = value;
        selects.forEach(function (select) {
            select.disabled = value;
        });
    }

    function operationLabel(operation) {
        var labels = {
            trim: "앞뒤 공백 제거",
            collapse_whitespace: "연속 공백·탭·줄바꿈을 한 칸으로 통일"
        };

        return labels[operation] || operation;
    }

    function renderNormalizationPreview(container, data) {
        container.textContent = "";

        var title = document.createElement("h3");
        title.textContent = "표본 정제 미리보기";
        container.appendChild(title);

        var summary = document.createElement("p");
        summary.textContent =
            "표본 " + data.sample_count + "행 중 " +
            data.changed_count + "행 변경";
        container.appendChild(summary);

        var rules = document.createElement("p");
        rules.className = "norm-preview-note";
        rules.textContent = "미리보기 규칙: " +
            data.rule_set.rules.map(function (rule) {
                return operationLabel(rule.operation);
            }).join(" → ");
        container.appendChild(rules);

        var note = document.createElement("p");
        note.className = "norm-preview-note";
        note.textContent =
            "선택 범위의 앞부분 표본만 확인한 결과입니다. " +
            "Excel 셀에는 아직 반영하지 않았습니다.";
        container.appendChild(note);

        if (data.changed_count === 0) {
            var unchanged = document.createElement("p");
            unchanged.textContent =
                "현재 규칙으로 달라지는 표본이 없습니다.";
            container.appendChild(unchanged);
        }

        var changedRows = data.rows.filter(function (row) {
    return row.changed;
});

            // 변경이 없으면 위에서 만든 안내 문구까지만 표시한다.
            if (changedRows.length === 0) {
                return;
            }

            var toggleButton = document.createElement("button");
            toggleButton.type = "button";
            toggleButton.className = "norm-preview-button";
            toggleButton.textContent = "변경된 " + changedRows.length + "행 보기";
            toggleButton.setAttribute("aria-expanded", "false");
            container.appendChild(toggleButton);

            var details = document.createElement("div");
            details.hidden = true;

            toggleButton.addEventListener("click", function () {
                details.hidden = !details.hidden;

                toggleButton.textContent = details.hidden
                    ? "변경된 " + changedRows.length + "행 보기"
                    : "변경된 행 접기";

                toggleButton.setAttribute(
                    "aria-expanded",
                    String(!details.hidden)
                );
            });

            changedRows.forEach(function (row) {
            var item = document.createElement("div");
            item.className = "norm-preview-row";
            if (row.changed) item.classList.add("is-changed");

            var heading = document.createElement("strong");
            heading.textContent =
                "Excel " + row.excel_row + "행 · " +
                (row.changed ? "변경됨" : "변경 없음");
            item.appendChild(heading);

            var names = document.createElement("p");
            names.textContent =
                "거래품명: " + row.trade_name + "\n" +
                "신고품명: " + row.declared_name;
            item.appendChild(names);

            var values = document.createElement("pre");
            // 따옴표와 이스케이프 표기로 공백·탭·줄바꿈 차이를 보여준다.
            values.textContent =
                "전: " + JSON.stringify(row.original_model_spec) + "\n" +
                "후: " + JSON.stringify(row.normalized_model_spec);
            item.appendChild(values);

            var applied = document.createElement("p");
            applied.className = "norm-preview-note";
            applied.textContent = row.applied_operations.length
                ? "변경을 일으킨 규칙: " +
                    row.applied_operations.map(operationLabel).join(", ")
                : "변경을 일으킨 규칙 없음";
            item.appendChild(applied);

            details.appendChild(item);
        });

        container.appendChild(details);
    }

    function addPreviewAction(bubble, jobId) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "norm-preview-button";
        button.textContent = "공백 정리 미리보기";
        button.disabled = sending || workflowBusy;
        bubble.appendChild(button);

        var feedback = document.createElement("p");
        feedback.className = "norm-preview-note";
        feedback.setAttribute("role", "status");
        bubble.appendChild(feedback);

        var container = document.createElement("section");
        container.className = "norm-result-preview";
        container.hidden = true;
        bubble.appendChild(container);

        previewButton = button;

        button.addEventListener("click", async function () {
            if (sending || workflowBusy || button !== previewButton) return;

            setBusy(true);
            feedback.textContent = "표본을 정제하고 있습니다…";

            try {
                var data = await requestJson(
                    "/normalization/jobs/" +
                        encodeURIComponent(jobId) + "/preview",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            rules: [
                                { operation: "trim" },
                                { operation: "collapse_whitespace" }
                            ]
                        })
                    }
                );

                renderNormalizationPreview(container, data);
                container.hidden = false;
                feedback.textContent = "";
                button.hidden = true;
                scrollArea.scrollTop = scrollArea.scrollHeight;
            } catch (error) {
                feedback.textContent =
                    "미리보기 실패: " + error.message;
            } finally {
                setBusy(false);
            }
        });
    }

    function renderJob(job) {
        var labels = {
            CREATED: "작업 생성됨",
            ANALYZING: "LLM 확인 중",
            REVIEW_READY: "표본 확인 완료 · 규칙 승인 전",
            FAILED: "확인 실패"
        };

        statusText.textContent =
            labels[job.status] + " · 작업 " + job.job_id;

        if (job.status === 'REVIEW_READY') {
            if (!resultBubble) {
                resultBubble = appendMessage('assistant', job.analysis);
                resultText = resultBubble.querySelector('p');

                addPreviewAction(resultBubble, job.job_id);
            } else {
                resultText.textContent = job.analysis;
            }
            mappingPanel.hidden = true;
            selectButton.textContent = '다시 선택';
            statusText.textContent = sourceText.textContent + ' · 범위·열 설정 확인됨';
            analyzeButton.textContent = '이 설정으로 확인';
        } else if (job.error) {
            statusText.textContent = job.error;
        }
    }

    selects.forEach(function (select) {
        select.addEventListener("change", function () {
            // 열 역할이 바뀌면 다음 실행은 새 작업이다.
            payload = null;
            refreshButton.disabled = true;
            clearResult();
            statusText.textContent = "열 역할 변경됨 · 다시 확인하세요.";
        });
    });

    selectButton.addEventListener("click", async function () {
        if (sending || workflowBusy) return;
        archivePanel();
        openPanel();
        conversation.appendChild(panel);
        setBusy(true);
        selection = null;
        payload = null;
        mappingPanel.hidden = true;
        refreshButton.disabled = true;
        clearResult();

        try {
            if (!ready || typeof Excel === "undefined") {
                throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
            }

            if (!Office.context.requirements.isSetSupported(
                "ExcelApi", "1.1"
            )) {
                throw new Error("ExcelApi 1.1 지원이 필요합니다.");
            }

            selection = await Excel.run(async function (context) {
                var range = context.workbook.getSelectedRange();
                var sheet = range.worksheet;

                // 전체 셀 내용은 로드하지 않는다.
                range.load(
                    "address,rowCount,columnCount,rowIndex,columnIndex"
                );
                sheet.load("id,name");

                await context.sync();

                if (range.columnCount !== 3) {
                    throw new Error(
                        "서로 붙어 있는 세 열을 선택하세요."
                    );
                }

                if (range.rowCount < 2 || range.rowCount > 400001) {
                    throw new Error(
                        "머리글과 데이터 1~400,000행을 선택하세요. " +
                        "열 전체 선택은 지원하지 않습니다."
                    );
                }

                // 머리글 1행 + 데이터 최대 20행만 읽는다.
                var count = Math.min(range.rowCount, 21);
                var sampleRange = range.getCell(0, 0)
                    .getResizedRange(count - 1, 2);

                sampleRange.load("text");
                await context.sync();

                var rows = sampleRange.text;

                if (rows.some(function (row) {
                    return row.some(function (cell) {
                        return cell.length > 1000;
                    });
                })) {
                    throw new Error(
                        "표본에 1,000자를 넘는 셀이 있습니다. " +
                        "선택한 열이 맞는지 확인하세요."
                    );
                }

                return {
                    worksheet_id: sheet.id,
                    sheet_name: sheet.name,
                    address: range.address,
                    row_start: range.rowIndex,
                    column_start: range.columnIndex,
                    row_count: range.rowCount,
                    headers: rows[0],
                    samples: rows.slice(1).map(function (row) {
                        return { cells: row };
                    })
                };
            });

            var expected = ["거래품명", "신고품명", "모델규격"];

            selects.forEach(function (select, roleIndex) {
                select.textContent = "";

                selection.headers.forEach(function (header, index) {
                    var option = document.createElement("option");
                    option.value = String(index);
                    option.textContent =
                        (index + 1) + "번째 열 · " +
                        (header || "(머리글 없음)");
                    select.appendChild(option);
                });

                var matched = selection.headers.findIndex(
                    function (header) {
                        return header.trim() === expected[roleIndex];
                    }
                );

                select.value = String(
                    matched >= 0 ? matched : roleIndex
                );
            });

            sourceText.textContent =
                selection.address + " · 데이터 " +
                (selection.row_count - 1) + "행 · " +
                "앞부분 표본 " + selection.samples.length + "행";

            preview.textContent = [
                selection.headers.join(" | ")
            ].concat(
                selection.samples.map(function (row) {
                    return row.cells.join(" | ");
                })
            ).join("\n");

            mappingPanel.hidden = false;
            selectButton.textContent = '다시 선택';
            statusText.textContent =
                "세 열의 역할을 확인한 뒤 LLM 확인을 눌러주세요.";

        } catch (error) {
            selection = null;
            statusText.textContent = error.message;
        } finally {
            setBusy(false);
        }
    });

    analyzeButton.addEventListener("click", async function () {
        if (!selection || sending || workflowBusy) {
            return;
        }

        setBusy(true);

        try {
            var indexes = selects.map(function (select) {
                return Number(select.value);
            });

            if (new Set(indexes).size !== 3) {
                throw new Error(
                    "거래품명·신고품명·모델규격에 " +
                    "서로 다른 열을 지정하세요."
                );
            }

            // 응답 유실 후 재시도해도 같은 작업 ID를 사용한다.
            if (!payload) {
                if (!conversationId) {
                    throw new Error("먼저 새 대화를 시작해 주세요.");
                }

                payload = Object.assign({}, selection, {
                    conversation_id: conversationId,
                    job_id: newRequestId(),
                    mapping: {
                        trade_name: indexes[0],
                        declared_name: indexes[1],
                        model_spec: indexes[2]
                    }
                });
            }

            statusText.textContent = "작업 생성 중…";

            var job = await requestJson("/normalization/jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            renderJob(job);
            refreshButton.disabled = false;
            statusText.textContent = "LLM이 표본을 확인하고 있습니다…";

            job = await requestJson(
                "/normalization/jobs/" + payload.job_id + "/analyze",
                { method: "POST" }
            );

            renderJob(job);

        } catch (error) {
            statusText.textContent =
                error.message + " 작업 상태 조회 또는 재시도를 해주세요.";
        } finally {
            setBusy(false);
        }
    });

    refreshButton.addEventListener("click", async function () {
        if (!payload || sending || workflowBusy || refreshing) {
            return;
        }
        refreshing = true;
        setBusy(true);

        try {
            var job = await requestJson(
                "/normalization/jobs/" + payload.job_id
            );
            renderJob(job);
        } catch (error) {
            statusText.textContent = error.message;
        } finally {
            refreshing = false;
            setBusy(false);
        }
    });
})();