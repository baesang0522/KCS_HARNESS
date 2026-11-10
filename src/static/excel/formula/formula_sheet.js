"use strict";
(function () {
    var batchSize = 1000;
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

            var inputs = target && target.input_columns || [];
            if (inputs.length > 20 || (!inputs.length && range.columnCount > 20)) {
                throw new Error("수식 작업은 최대 20열 범위를 선택하세요.");
            }

            var sampleSize = Math.min(20, range.rowCount);
            var samples = inputs.length ? inputs.map(function (input) {
                return sheet.getRangeByIndexes(range.rowIndex, input.column_index, sampleSize, 1);
            }) : [range.getCell(0, 0).getResizedRange(sampleSize - 1, range.columnCount - 1)];
            samples.forEach(function (sample) { sample.load("text"); });
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
                workspace_id: inputs.length ? target.workspace_id : null,
                table_id: inputs.length ? target.table_id : null,
                workspace_task_type: inputs.length ? target.workspace_task_type : null,
                input_columns: inputs,
                samples: Array.from({length: sampleSize}, function (_, index) {
                    var cells = inputs.length ? samples.map(function (sample) { return sample.text[index][0]; }) : samples[0].text[index];
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

    function inspectFormulaTarget(target) {
        target.load("address,rowCount,columnCount,rowIndex,columnIndex");
        // 전체 셀 값을 전송하지 않고 빈 문자열을 반환하는 수식까지 검사한다.
        return {range: target,
            constants: target.getSpecialCellsOrNullObject("Constants"),
            formulas: target.getSpecialCellsOrNullObject("Formulas")};
    }

    function formulaTargetSnapshot(inspection, formula, sourceAddress, reason) {
        if (!inspection.constants.isNullObject || !inspection.formulas.isNullObject) return null;
        var target = inspection.range;
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
                return inspectFormulaTarget(target);
            });
            await context.sync();

            var snapshots = planned.map(function (target, index) {
                if (formulaTargetOverlaps(target.range, selection)) {
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
                row_count: snapshots[0].row_count,
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
                    planned[0].range.rowIndex,
                    startColumn + offset,
                    planned[0].range.rowCount,
                    1
                );
                candidates.push(inspectFormulaTarget(candidate));
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
            var planned = context.workbook.worksheets.getItem(selection.worksheet_id).getRange(preview.plan.actions[0].target_range);
            planned.load("rowIndex,rowCount");
            chosen.load("columnIndex");
            chosenSheet.load("name");
            await context.sync();
            if (chosenSheet.name !== selection.sheet_name) {
                throw new Error("원본과 같은 시트에서 결과 열을 선택하세요.");
            }
            var target = chosenSheet.getRangeByIndexes(
                planned.rowIndex,
                chosen.columnIndex,
                planned.rowCount,
                1
            );
            var inspection = inspectFormulaTarget(target);
            await context.sync();
            if (formulaTargetOverlaps(target, selection)) {
                throw new Error("결과 열은 원본 선택 범위와 겹칠 수 없습니다.");
            }
            var result = formulaTargetSnapshot(
                inspection, preview.plan.actions[0].formula, selection.address, "manual"
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

    async function applyFormulaPreview(preview, selection, progress) {
        await validateFormulaPreview(preview, selection);
        var actions = preview.plan.actions;
        var completed = 0, attempted = false, activeRange = "";
        try {
            return await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.worksheet_id);
                var targets = actions.map(function (action) {
                    var target = sheet.getRange(action.target_range);
                    target.load("address,rowCount,columnCount,rowIndex,columnIndex");
                    return target;
                });
                await context.sync();
                var total = targets.reduce(function (sum, target) { return sum + target.rowCount; }, 0);
                // 뒤 결과가 앞 결과를 참조할 수 있으므로 결과 열 순서대로 완료한다.
                for (var index = 0; index < targets.length; index++) {
                    var target = targets[index], action = actions[index];
                    var anchor = sheet.getRange(action.anchor_cell);
                    for (var offset = 0; offset < target.rowCount; offset += batchSize) {
                        var count = Math.min(batchSize, target.rowCount - offset);
                        var part = sheet.getRangeByIndexes(target.rowIndex + offset, target.columnIndex, count, 1);
                        activeRange = action.target_range + " 중 " + (target.rowIndex + offset + 1) +
                            "~" + (target.rowIndex + offset + count) + "행";
                        var inspection = inspectFormulaTarget(part);
                        await context.sync();
                        activeRange = part.address;
                        if (!inspection.constants.isNullObject || !inspection.formulas.isNullObject) {
                            throw new Error("작성할 범위에 기존 값이나 수식이 있습니다.");
                        }
                        if (progress) progress("수식 작성", completed, total);
                        attempted = true;
                        part.numberFormat = Array.from({length: count}, function () { return ["General"]; });
                        if (offset === 0) {
                            anchor.formulas = [[action.formula]];
                            if (count > 1) anchor.autoFill(part, "FillCopy");
                        } else {
                            // Excel의 복사를 사용해 상대·절대·혼합 참조를 그대로 유지한다.
                            part.copyFrom(anchor, "Formulas");
                        }
                        part.calculate();
                        part.load("valueTypes");
                        await context.sync();
                        var errors = part.valueTypes.filter(function (row) { return row[0] === "Error"; }).length;
                        if (errors) throw new Error("계산 결과에 Excel 오류가 " + errors + "개 있습니다.");
                        completed += count;
                        if (progress) progress("수식 계산 확인", completed, total);
                    }
                }
                return {
                    address: targets.map(function (target) { return target.address; }).join(", "),
                    row_count: targets[0].rowCount,
                    action_count: targets.length,
                    targets: targets.map(function (target) { return {row_start: target.rowIndex, row_count: target.rowCount,
                        column_start: target.columnIndex, column_count: target.columnCount}; })
                };
            });
        } catch (error) {
            error.message = (attempted ? "일부 수식이 작성되었을 수 있습니다. " : "수식을 작성하지 않았습니다. ") +
                "계산 확인 완료 " + completed + "셀 · 확인할 범위: " + activeRange + ". " + error.message;
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
