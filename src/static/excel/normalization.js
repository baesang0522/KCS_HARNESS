"use strict";

(function () {
    var selectButton = document.getElementById("norm-select");
    var analyzeButton = document.getElementById("norm-analyze");
    var refreshButton = document.getElementById("norm-refresh");
    var mappingPanel = document.getElementById("norm-mapping");
    var sourceText = document.getElementById("norm-source");
    var preview = document.getElementById("norm-preview");
    var statusText = document.getElementById("norm-status");
    var resultText = document.getElementById("norm-result");

    var selects = [
        document.getElementById("norm-trade"),
        document.getElementById("norm-declared"),
        document.getElementById("norm-spec")
    ];

    var selection = null;
    var payload = null;

    function setBusy(value) {
        selectButton.disabled = value;
        analyzeButton.disabled = value;
        selects.forEach(function (select) {
            select.disabled = value;
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

        resultText.textContent = job.error || job.analysis || "";
    }

    selects.forEach(function (select) {
        select.addEventListener("change", function () {
            // 열 역할이 바뀌면 다음 실행은 새 작업이다.
            payload = null;
            refreshButton.disabled = true;
            resultText.textContent = "";
            statusText.textContent = "열 역할 변경됨 · 다시 확인하세요.";
        });
    });

    selectButton.addEventListener("click", async function () {
        setBusy(true);
        selection = null;
        payload = null;
        mappingPanel.hidden = true;
        refreshButton.disabled = true;
        resultText.textContent = "";

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
                selection.samples.slice(0, 3).map(function (row) {
                    return row.cells.join(" | ");
                })
            ).join("\n");

            mappingPanel.hidden = false;
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
        if (!selection) {
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
                payload = Object.assign({}, selection, {
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
        if (!payload) {
            return;
        }

        try {
            var job = await requestJson(
                "/normalization/jobs/" + payload.job_id
            );
            renderJob(job);
        } catch (error) {
            statusText.textContent = error.message;
        }
    });
})();