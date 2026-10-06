"use strict";
(function () {
    function requireFormulaHost() {
        if (typeof Excel === "undefined" || typeof Office === "undefined") {
            throw new Error("엑셀 안에서 추가 기능을 열어주세요.");
        }
        if (!Office.context.requirements.isSetSupported("ExcelApi", "1.9")) {
            throw new Error("Excel 2021 이상의 ExcelApi 1.9 지원이 필요합니다.");
        }
    }

    async function readFormulaContext(target) {
        requireFormulaHost();
        return await Excel.run(async function (context) {
            var range = target ? context.workbook.worksheets.getItem(target.worksheet_id)
                .getRangeByIndexes(target.row_start, target.column_start, target.row_count, target.column_count) : context.workbook.getSelectedRange();
            var sheet = range.worksheet;
            var used = sheet.getUsedRange(true);
            range.load("address,rowCount,columnCount,rowIndex,columnIndex");
            used.load("address,rowCount,columnCount,rowIndex,columnIndex");
            sheet.load("id,name");
            await context.sync();

            if (range.rowCount > 10000 || range.columnCount > 20) {
                throw new Error("수식 작업은 최대 10,000행·20열 범위를 선택하세요.");
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
            var sheet = context.workbook.worksheets.getItem(selection.worksheet_id);
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
        // 승인 전에는 실제 셀에 수식을 쓰지 않는다. 계산 검증은 승인 후에 수행한다.
        var current = await prepareFormulaPreview(preview, selection);
        var ranges = current.target_ranges || [current.target_range];
        if (preview.plan.actions.some(function (action, index) { return action.target_range !== ranges[index]; })) {
            throw new Error("결과 범위가 바뀌었습니다. 새 위치를 확인한 뒤 다시 승인하세요.");
        }
    }

    async function applyFormulaPreview(preview, selection) {
        await validateFormulaPreview(preview, selection);
        var actions = preview.plan.actions;
        try {
            return await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.worksheet_id);
                var targets = actions.map(function (action) {
                    var target = sheet.getRange(action.target_range);
                    var anchor = sheet.getRange(action.anchor_cell);
                    // 텍스트 서식이 상속된 열도 수식으로 계산되도록 먼저 변경한다.
                    target.numberFormat = [["General"]];
                    anchor.formulas = [[action.formula]];
                    if (action.mode === "fill_down") {
                        anchor.autoFill(action.target_range, "FillCopy");
                    }
                    target.calculate();
                    target.load("address,rowCount,columnCount,rowIndex,columnIndex,text");
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
                    action_count: targets.length,
                    targets: targets.map(function (target) { return {row_start: target.rowIndex, row_count: target.rowCount,
                        column_start: target.columnIndex, column_count: target.columnCount}; })
                };
            });
        } catch (error) {
            error.message = "일부 수식이 작성되었을 수 있습니다. 결과 범위를 확인하세요. " + error.message;
            throw error;
        }
    }


    window.formulaSheet = {
        readFormulaContext: readFormulaContext,
        prepareFormulaPreview: prepareFormulaPreview,
        readFormulaTarget: readFormulaTarget,
        validateFormulaPreview: validateFormulaPreview,
        applyFormulaPreview: applyFormulaPreview
    };
})();
