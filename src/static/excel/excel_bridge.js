"use strict";

(function () {
    // 모델규격 정제용 3열 표본. UI와 서버 요청은 호출자가 담당한다.
    async function readNormalizationRows() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }

        return await Excel.run(async function (context) {
            var range = context.workbook.getSelectedRange();
            var sheet = range.worksheet;

            range.load("address,rowCount,columnCount,rowIndex,columnIndex");
            sheet.load("id,name");
            await context.sync();

            if (range.columnCount !== 3) {
                throw new Error("서로 붙어 있는 세 열을 선택하세요.");
            }

            if (range.rowCount < 2 || range.rowCount > 400001) {
                throw new Error(
                    "머리글과 데이터 1~400,000행을 선택하세요. " +
                    "열 전체 선택은 지원하지 않습니다."
                );
            }

            var rows = [];

            for (var offset = 0; offset < range.rowCount; offset += 200) {
                var size = Math.min(200, range.rowCount - offset);
                var chunk = range.getCell(offset, 0)
                    .getResizedRange(size - 1, 2);

                chunk.load("text");
                await context.sync();

                if (chunk.text.some(function (row) {
                    return row.some(function (cell) {
                        return cell.length > 1000;
                    });
                })) {
                    throw new Error(
                        "선택 영역에 1,000자를 넘는 셀이 있습니다."
                    );
                }

                rows.push.apply(rows, chunk.text);
            }

            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                headers: rows[0],
                rows: rows.slice(1).map(function (row) {
                    return { cells: row };
                })
            };
        });
    }
  
    async function writeNormalizationPreview(preview) {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }

        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }

        if (
            !preview.rows.length ||
            preview.rows.length > 400000 ||
            preview.row_count !== preview.rows.length
        ) {
            throw new Error("승인된 전체 결과의 행 수가 올바르지 않습니다.");
        }

        var sheetName = "정제_" +
            preview.preview_id.replace(/-/g, "").slice(0, 24);

        return await Excel.run(async function (context) {
            var sheets = context.workbook.worksheets;
            sheets.load("items/name");
            await context.sync();

            if (sheets.items.some(function (sheet) {
                return sheet.name === sheetName;
            })) {
                throw new Error(
                    sheetName + " 시트가 이미 있습니다. " +
                    "이전 출력 또는 부분 출력 결과를 확인하세요."
                );
            }

            var sheet = sheets.add(sheetName);

            try {
                sheet.getRange("A1:E1").values = [[
                    "원본 행 번호",
                    "거래품명",
                    "신고품명",
                    "원본 모델규격",
                    "정제 모델규격"
                ]];
                sheet.getRange("A1:E1").format.font.bold = true;
                await context.sync();

                for (
                    var offset = 0;
                    offset < preview.rows.length;
                    offset += 200
                ) {
                    var rows = preview.rows.slice(offset, offset + 200);
                    var start = offset + 2;
                    var end = start + rows.length - 1;
                    var range = sheet.getRange("A" + start + ":E" + end);

                    range.numberFormat = rows.map(function () {
                        return ["@", "@", "@", "@", "@"];
                    });
                    await context.sync();

                    range.values = rows.map(function (row) {
                        return [
                            row.excel_row,
                            row.trade_name,
                            row.declared_name,
                            row.original_model_spec,
                            row.normalized_model_spec
                        ].map(function (value) {
                            return typeof value === "string" && value !== ""
                                ? "'" + value
                                : value;
                        });
                    });

                    rows.forEach(function (row, index) {
                        if (row.changed) {
                            var outputRow = start + index;
                            sheet.getRange(
                                "A" + outputRow + ":E" + outputRow
                            ).format.fill.color = "#FFF2CC";
                        }
                    });

                    range.format.columnWidth = 130;
                    range.format.wrapText = true;
                    await context.sync();
                }

                sheet.activate();
                await context.sync();
            } catch (error) {
                throw new Error(
                    sheetName + " 시트에 일부 결과가 남아 있을 수 있습니다. " +
                    "해당 시트를 확인하세요. " + error.message
                );
            }

            return {
                sheet_name: sheetName,
                row_count: preview.rows.length
            };
        });
    }
  
    async function readCounterpartyRows() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }
        return await Excel.run(async function (context) {
            var range = context.workbook.getSelectedRange();
            var sheet = range.worksheet;
            range.load("address,rowCount,columnCount,rowIndex,columnIndex");
            sheet.load("id,name");
            await context.sync();
            if (range.columnCount !== 3) {
                throw new Error("머리글을 포함한 서로 붙어 있는 세 열을 선택하세요.");
            }
            if (range.rowCount < 2) {
                throw new Error("머리글과 데이터 한 행 이상을 선택하세요.");
            }
            var rows = [];
            // 청크 크기는 총행 수 제한이 아니다.
            for (var offset = 0; offset < range.rowCount; offset += 1000) {
                var size = Math.min(1000, range.rowCount - offset);
                var data = range.getCell(offset, 0).getResizedRange(size - 1, 2);
                data.load("text");
                await context.sync();
                if (data.text.some(function (row) {
                    return row.some(function (cell) { return cell.length > 1000; });
                })) {
                    throw new Error("선택한 데이터에 1,000자를 넘는 셀이 있습니다.");
                }
                rows.push.apply(rows, data.text);
            }
            return {
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                headers: rows[0],
                rows: rows.slice(1).map(function (row) { return { cells: row }; })
            };
        });
    }

    async function writeCounterpartyPreview(preview) {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.1")) {
            throw new Error("ExcelApi 1.1 지원이 필요합니다.");
        }
        if (!preview.rows.length) {
            throw new Error("승인한 후보가 없습니다.");
        }

        var sheetName = "거래처_" +
            preview.preview_id.replace(/-/g, "").slice(0, 24);
        return await Excel.run(async function (context) {
            var sheets = context.workbook.worksheets;
            sheets.load("items/name");
            await context.sync();
            if (sheets.items.some(function (sheet) { return sheet.name === sheetName; })) {
                throw new Error(sheetName + " 시트가 이미 있습니다. 이전 출력 결과를 확인하세요.");
            }

            var values = [[
                "원본 행 번호", "국가코드", "상호명", "기존 해외거래처부호",
                "대표 해외거래처부호", "변경 여부", "후보 그룹"
            ]].concat(preview.rows.map(function (row) {
                return [
                    row.excel_row, row.country_code, row.company_name,
                    row.original_party_code, row.representative_party_code,
                    row.changed ? "변경" : "유지", row.group_id
                ];
            }));
            var sheet = sheets.add(sheetName);
            var range = sheet.getRange("A1:G" + values.length);
            range.numberFormat = values.map(function () {
                return ["@", "@", "@", "@", "@", "@", "@"];
            });
            await context.sync();
            range.values = values.map(function (row) {
                return row.map(function (value) {
                    return typeof value === "string" && value !== "" ? "'" + value : value;
                });
            });
            sheet.getRange("A1:G1").format.font.bold = true;
            preview.rows.forEach(function (row, index) {
                if (row.changed) {
                    sheet.getRange("A" + (index + 2) + ":G" + (index + 2))
                        .format.fill.color = "#FFF2CC";
                }
            });
            range.format.columnWidth = 130;
            range.format.wrapText = true;
            sheet.activate();
            await context.sync();
            return {sheet_name: sheetName, row_count: preview.rows.length};
        });
    }

    function requireFormulaHost() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.9")) {
            throw new Error("Excel 2021 이상의 ExcelApi 1.9 지원이 필요합니다.");
        }
    }

    async function readFormulaContext() {
        requireFormulaHost();
        return await Excel.run(async function (context) {
            var range = context.workbook.getSelectedRange();
            var sheet = range.worksheet;
            var used = sheet.getUsedRange(true);
            range.load("address,rowCount,columnCount,rowIndex,columnIndex");
            used.load("address,rowCount,columnCount,rowIndex,columnIndex");
            sheet.load("id,name");
            await context.sync();

            if (range.rowCount > 400000 || range.columnCount > 20) {
                throw new Error("수식 작업은 최대 400,000행·20열 범위를 선택하세요.");
            }

            var sampleSize = Math.min(20, range.rowCount);
            var sample = range.getCell(0, 0).getResizedRange(
                sampleSize - 1,
                range.columnCount - 1
            );
            sample.load("text");
            var usedSample = used.getCell(0, 0).getResizedRange(
                Math.min(20, used.rowCount) - 1,
                Math.min(20, used.columnCount) - 1
            );
            usedSample.load("text");
            await context.sync();

            return {
                task_type: "formula",
                worksheet_id: sheet.id,
                sheet_name: sheet.name,
                address: range.address,
                row_start: range.rowIndex,
                column_start: range.columnIndex,
                row_count: range.rowCount,
                column_count: range.columnCount,
                samples: sample.text.map(function (cells) {
                    return {cells: cells};
                }),
                sheet_context: {
                    address: used.address,
                    row_start: used.rowIndex,
                    column_start: used.columnIndex,
                    row_count: used.rowCount,
                    column_count: used.columnCount,
                    samples: usedSample.text.map(function (cells) {
                        return {cells: cells};
                    })
                }
            };
        });
    }

    function formulaTargetSnapshot(target, formula, sourceAddress, reason) {
        var occupied = target.values.some(function (row, rowIndex) {
            return row.some(function (value, columnIndex) {
                return value !== "" || target.formulas[rowIndex][columnIndex] !== "";
            });
        });
        if (occupied) return null;
        return {
            address: target.address,
            target_range: target.address.slice(target.address.lastIndexOf("!") + 1)
                .replace(/\$/g, ""),
            anchor_cell: target.address.slice(target.address.lastIndexOf("!") + 1)
                .split(":", 1)[0].replace(/\$/g, ""),
            row_count: target.rowCount,
            column_count: target.columnCount,
            formula: formula,
            source_address: sourceAddress,
            reason: reason
        };
    }

    function formulaTargetOverlaps(target, selection) {
        return (
            target.rowIndex < selection.row_start + selection.row_count &&
            target.rowIndex + target.rowCount > selection.row_start &&
            target.columnIndex < selection.column_start + selection.column_count &&
            target.columnIndex + target.columnCount > selection.column_start
        );
    }

    async function prepareFormulaPreview(preview, selection) {
        requireFormulaHost();
        return await Excel.run(async function (context) {
            var actions = preview.plan.actions;
            var sheet = context.workbook.worksheets.getItem(selection.sheet_name);
            var planned = actions.map(function (action) {
                var target = sheet.getRange(action.target_range);
                target.load("address,rowCount,columnCount,rowIndex,columnIndex,values,formulas");
                return target;
            });
            await context.sync();

            var snapshots = planned.map(function (target, index) {
                if (formulaTargetOverlaps(target, selection)) {
                    throw new Error("결과 범위가 원본 선택 범위와 겹칩니다.");
                }
                return formulaTargetSnapshot(
                    target, actions[index].formula, selection.address, "planned"
                );
            });
            if (snapshots.every(Boolean)) return {
                address: snapshots.map(function (item) { return item.address; }).join(", "),
                target_ranges: snapshots.map(function (item) { return item.target_range; }),
                anchor_cells: snapshots.map(function (item) { return item.anchor_cell; }),
                row_count: selection.row_count,
                reason: "planned"
            };
            if (actions.length > 1) {
                throw new Error("복수 결과 열 중 기존 값이 있는 열이 있습니다. 빈 열로 다시 요청해 주세요.");
            }

            // ponytail: 가까운 20개 열만 한 번에 확인한다. 더 먼 자동 탐색이 필요하면 범위를 늘린다.
            var startColumn = selection.column_start + selection.column_count;
            var count = Math.min(20, 16384 - startColumn);
            var candidates = [];
            for (var offset = 0; offset < count; offset += 1) {
                var candidate = sheet.getRangeByIndexes(
                    selection.row_start,
                    startColumn + offset,
                    selection.row_count,
                    1
                );
                candidate.load("address,rowCount,columnCount,rowIndex,columnIndex,values,formulas");
                candidates.push(candidate);
            }
            await context.sync();
            var result;
            for (var index = 0; index < candidates.length; index += 1) {
                result = formulaTargetSnapshot(
                    candidates[index], actions[0].formula, selection.address, "automatic"
                );
                if (result) return result;
            }
            throw new Error("오른쪽 20개 열에서 빈 결과 범위를 찾지 못했습니다. 원하는 열을 선택해 주세요.");
        });
    }

    async function readFormulaTarget(preview, selection) {
        requireFormulaHost();
        if (preview.plan.actions.length > 1) {
            throw new Error("복수 결과 작업은 계획된 열을 함께 사용합니다.");
        }
        return await Excel.run(async function (context) {
            var chosen = context.workbook.getSelectedRange();
            var chosenSheet = chosen.worksheet;
            chosen.load("columnIndex");
            chosenSheet.load("name");
            await context.sync();
            if (chosenSheet.name !== selection.sheet_name) {
                throw new Error("원본과 같은 시트에서 결과 열을 선택하세요.");
            }
            var target = chosenSheet.getRangeByIndexes(
                selection.row_start,
                chosen.columnIndex,
                selection.row_count,
                1
            );
            target.load("address,rowCount,columnCount,rowIndex,columnIndex,values,formulas");
            await context.sync();
            if (formulaTargetOverlaps(target, selection)) {
                throw new Error("결과 열은 원본 선택 범위와 겹칠 수 없습니다.");
            }
            var result = formulaTargetSnapshot(
                target, preview.plan.actions[0].formula, selection.address, "manual"
            );
            if (!result) {
                throw new Error("선택한 결과 범위에 기존 값이나 수식이 있습니다.");
            }
            return result;
        });
    }

    async function validateFormulaPreview(preview, selection) {
        requireFormulaHost();
        return await Excel.run(async function (context) {
            var sheet = context.workbook.worksheets.getItem(selection.sheet_name);
            var targets = [];
            var errors = 0;
            try {
                preview.plan.actions.forEach(function (action) {
                    var target = sheet.getRange(action.target_range);
                    var anchor = sheet.getRange(action.anchor_cell);
                    anchor.formulas = [[action.formula]];
                    if (action.mode === "fill_down") {
                        anchor.autoFill(action.target_range, "FillCopy");
                    }
                    target.calculate();
                    target.load("text");
                    targets.push(target);
                });
                await context.sync();
                targets.forEach(function (target) {
                    target.text.forEach(function (row) {
                        errors += row.filter(function (value) {
                            return typeof value === "string" && value.startsWith("#");
                        }).length;
                    });
                });
            } finally {
                targets.forEach(function (target) { target.clear("Contents"); });
                await context.sync();
            }
            if (errors) {
                throw new Error("미리 계산한 결과에 Excel 오류가 " + errors + "개 있습니다.");
            }
        });
    }

    async function applyFormulaPreview(preview, selection) {
        await prepareFormulaPreview(preview, selection);
        var actions = preview.plan.actions;
        try {
            return await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.sheet_name);
                var targets = actions.map(function (action) {
                    var target = sheet.getRange(action.target_range);
                    var anchor = sheet.getRange(action.anchor_cell);
                    anchor.formulas = [[action.formula]];
                    if (action.mode === "fill_down") {
                        anchor.autoFill(action.target_range, "FillCopy");
                    }
                    target.calculate();
                    target.load("address,rowCount,text");
                    return target;
                });
                await context.sync();

                var errors = targets.reduce(function (count, target) {
                    return count + target.text.reduce(function (targetCount, row) {
                        return targetCount + row.filter(function (value) {
                            return typeof value === "string" && value.startsWith("#");
                        }).length;
                    }, 0);
                }, 0);
                if (errors) {
                    throw new Error("계산 결과에 Excel 오류가 " + errors + "개 있습니다.");
                }
                return {
                    address: targets.map(function (target) { return target.address; }).join(", "),
                    row_count: selection.row_count,
                    action_count: targets.length
                };
            });
        } catch (error) {
            await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.sheet_name);
                actions.forEach(function (action) {
                    sheet.getRange(action.target_range).clear("Contents");
                });
                await context.sync();
            });
            throw error;
        }
    }


    window.excelBridge = {
        readNormalizationRows: readNormalizationRows,
        writeNormalizationPreview: writeNormalizationPreview,
        readCounterpartyRows: readCounterpartyRows,
        writeCounterpartyPreview: writeCounterpartyPreview,
        readFormulaContext: readFormulaContext,
        prepareFormulaPreview: prepareFormulaPreview,
        readFormulaTarget: readFormulaTarget,
        validateFormulaPreview: validateFormulaPreview,
        applyFormulaPreview: applyFormulaPreview
    };
})();
