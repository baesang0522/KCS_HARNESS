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

    async function readReferenceSheet(context, sheet) {
        var used = sheet.getUsedRange(true);
        sheet.load("id,name"); used.load("address,rowIndex,columnIndex,rowCount,columnCount");
        sheet.tables.load("items/id");
        await context.sync();
        var sample = used.getCell(0, 0).getResizedRange(Math.min(20, used.rowCount) - 1, Math.min(20, used.columnCount) - 1);
        sample.load("text");
        var tables = sheet.tables.items.map(function (table) {
            var header = table.getHeaderRowRange(), range = table.getRange(), body = table.getDataBodyRange();
            header.load("values"); range.load("address"); body.load("address");
            return {table: table, header: header, range: range, body: body};
        });
        await context.sync();
        return {worksheet_id: sheet.id, sheet_name: sheet.name, address: used.address,
            row_start: used.rowIndex, column_start: used.columnIndex, row_count: used.rowCount, column_count: used.columnCount,
            samples: sample.text.map(function (cells) { return {cells: cells}; }),
            tables: tables.map(function (item) { return {table_id: String(item.table.id), address: item.range.address,
                data_address: item.body.address, headers: item.header.values[0].map(String)}; })};
    }

    async function readReferenceSheets(context, names, sourceId) {
        if (!names || !names.length) return [];
        var sheets = context.workbook.worksheets;
        sheets.load("items/id,items/name"); await context.sync();
        var references = [], seen = new Set();
        for (var name of names) {
            if (typeof name !== "string" || !name.trim()) throw new Error("참조할 시트 이름을 알려주세요.");
            var wanted = name.trim().toLowerCase();
            var matches = sheets.items.filter(function (sheet) { return sheet.name.toLowerCase() === wanted; });
            if (!matches.length) matches = sheets.items.filter(function (sheet) { return sheet.name.toLowerCase().startsWith(wanted); });
            if (matches.length !== 1) throw new Error("참조 시트 ‘" + name + "’를 하나로 확인하지 못했습니다. 시트 이름을 지정하세요: " +
                (matches.length ? matches : sheets.items).map(function (sheet) { return sheet.name; }).join(", "));
            var sheet = matches[0];
            if (sheet.id === sourceId || seen.has(sheet.id)) continue;
            seen.add(sheet.id); references.push(await readReferenceSheet(context, sheet));
        }
        return references;
    }

    async function validateReferenceSheets(selection) {
        if (!selection.reference_sheets || !selection.reference_sheets.length) return;
        await Excel.run(async function (context) {
            for (var expected of selection.reference_sheets) {
                var actual = await readReferenceSheet(context, context.workbook.worksheets.getItem(expected.worksheet_id));
                function layout(value) {
                    return JSON.stringify([value.worksheet_id, value.sheet_name, value.address, value.row_start, value.column_start,
                        value.row_count, value.column_count, value.tables]);
                }
                if (layout(actual) !== layout(expected)) throw new Error("참조 시트의 이름·범위·열 구성이 바뀌었습니다. 수식 계획을 다시 확인하세요.");
            }
        });
    }

    async function readFormulaContext(target, referenceNames) {
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
                reference_sheets: await readReferenceSheets(context, referenceNames, sheet.id),
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

    function formulaTargetSnapshot(inspection, formula, sourceAddress, reason, overwrite) {
        if (!overwrite && (!inspection.constants.isNullObject || !inspection.formulas.isNullObject)) return null;
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

    async function readFormulaTarget(preview, selection, destination) {
        requireFormulaHost();
        if (preview.plan.actions.length > 1) {
            throw new Error("복수 결과 작업은 계획된 열을 함께 사용합니다.");
        }
        return await Excel.run(async function (context) {
            var chosen = destination ? context.workbook.worksheets.getItem(destination.worksheet_id).getRangeByIndexes(selection.row_start, destination.column_index, 1, 1) : context.workbook.getSelectedRange();
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
                inspection, preview.plan.actions[0].formula, selection.address, "manual", true
            );
            result.overwrite = "allow";
            result.destination = destination || null;
            result.has_formulas = !inspection.formulas.isNullObject;
            // formulas에는 수식이 없는 셀의 상수도 들어간다. 재계산만으로는 충돌하지 않는다.
            result.previous_cells = [];
            for (var offset = 0; offset < target.rowCount; offset += batchSize) {
                var part = chosenSheet.getRangeByIndexes(target.rowIndex + offset, target.columnIndex,
                    Math.min(batchSize, target.rowCount - offset), 1);
                part.load("formulas");
                await context.sync();
                result.previous_cells.push(JSON.stringify(part.formulas));
            }
            return result;
        });
    }

    function validateOverwriteTarget(preview, selection, snapshot) {
        var actions = preview.plan.actions;
        if (actions.length !== 1 || !snapshot || snapshot.overwrite !== "allow" ||
            !snapshot.previous_cells || actions[0].target_range !== snapshot.target_range ||
            selection.address !== snapshot.source_address) {
            throw new Error("덮어쓸 결과 범위의 미리보기를 다시 준비하세요.");
        }
    }

    function validatePreviousCells(part, snapshot, offset) {
        if (JSON.stringify(part.formulas) !== snapshot.previous_cells[offset / batchSize]) {
            throw new Error("미리보기 이후 결과 범위의 값이나 수식이 바뀌었습니다. 다시 요청하세요.");
        }
    }

    async function validateFormulaPreview(preview, selection, snapshot) {
        await validateReferenceSheets(selection);
        if (preview.plan.actions.some(function (action) { return action.overwrite === "allow"; })) {
            validateOverwriteTarget(preview, selection, snapshot);
            return await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.worksheet_id);
                var target = sheet.getRange(snapshot.target_range);
                target.load("rowIndex,columnIndex,rowCount,columnCount");
                await context.sync();
                if (formulaTargetOverlaps(target, selection)) throw new Error("결과 범위가 원본 선택 범위와 겹칩니다.");
                for (var offset = 0; offset < target.rowCount; offset += batchSize) {
                    var part = sheet.getRangeByIndexes(target.rowIndex + offset, target.columnIndex,
                        Math.min(batchSize, target.rowCount - offset), 1);
                    part.load("formulas");
                    await context.sync();
                    validatePreviousCells(part, snapshot, offset);
                }
            });
        }
        // 승인 전에는 실제 셀에 수식을 쓰지 않는다. 계산 검증은 승인 후에 수행한다.
        var current = await prepareFormulaPreview(preview, selection);
        var ranges = current.target_ranges || [current.target_range];
        if (preview.plan.actions.some(function (action, index) { return action.target_range !== ranges[index]; })) {
            throw new Error("결과 범위가 바뀌었습니다. 새 위치를 확인한 뒤 다시 승인하세요.");
        }
    }

    async function applyFormulaPreview(preview, selection, progress, evidence, snapshot) {
        await validateFormulaPreview(preview, selection, snapshot);
        var actions = preview.plan.actions;
        var completed = 0, frozen = 0, attempted = false, activeRange = "", expectedFormulas = [];
        try {
            return await Excel.run(async function (context) {
                var sheet = context.workbook.worksheets.getItem(selection.worksheet_id);
                var targets = actions.map(function (action) {
                    var target = sheet.getRange(action.target_range);
                    target.load("address,rowCount,columnCount,rowIndex,columnIndex");
                    return target;
                });
                await context.sync();
                if (evidence) await evidence(context, sheet, targets, false);
                var total = targets.reduce(function (sum, target) { return sum + target.rowCount; }, 0);
                // 뒤 결과가 앞 결과를 참조할 수 있으므로 결과 열 순서대로 완료한다.
                for (var index = 0; index < targets.length; index++) {
                    var target = targets[index], action = actions[index];
                    var anchor = sheet.getRange(action.anchor_cell), expectedFormula = null;
                    for (var offset = 0; offset < target.rowCount; offset += batchSize) {
                        var count = Math.min(batchSize, target.rowCount - offset);
                        var part = sheet.getRangeByIndexes(target.rowIndex + offset, target.columnIndex, count, 1);
                        activeRange = action.target_range + " 중 " + (target.rowIndex + offset + 1) +
                            "~" + (target.rowIndex + offset + count) + "행";
                        var inspection = inspectFormulaTarget(part);
                        if (action.overwrite === "allow") part.load("formulas");
                        if (offset > 0) {
                            part.load("formulasR1C1");
                            anchor.load("formulasR1C1");
                        }
                        await context.sync();
                        activeRange = part.address;
                        if (offset > 0 && anchor.formulasR1C1[0][0] !== expectedFormula) {
                            throw new Error("작성 중 기준 수식이 바뀌었습니다. 결과를 확인하세요.");
                        }
                        // 표가 먼저 채운 수식은 상대·절대 참조까지 같은 경우에만 재작성 없이 검증한다.
                        var alreadyFilled = offset > 0 && part.formulasR1C1.every(function (row) {
                            return row[0] === expectedFormula;
                        });
                        if (action.overwrite === "allow" && !alreadyFilled) {
                            validatePreviousCells(part, snapshot, offset);
                        } else if (action.overwrite !== "allow" && (!inspection.constants.isNullObject || (!inspection.formulas.isNullObject && !alreadyFilled))) {
                            throw new Error("작성할 범위에 기존 값이나 수식이 있습니다.");
                        }
                        if (!alreadyFilled) {
                            if (progress) progress("수식 작성", completed, total);
                            attempted = true;
                            part.numberFormat = Array.from({length: count}, function () { return ["General"]; });
                            if (offset === 0) {
                                anchor.formulas = [[action.formula]];
                                if (count > 1) anchor.autoFill(part, "FillCopy");
                                anchor.load("formulasR1C1");
                            } else {
                                // Excel의 복사를 사용해 상대·절대·혼합 참조를 그대로 유지한다.
                                part.copyFrom(anchor, "Formulas");
                            }
                        }
                        part.calculate();
                        part.load("valueTypes");
                        await context.sync();
                        if (offset === 0) {
                            expectedFormula = anchor.formulasR1C1[0][0];
                            expectedFormulas[index] = expectedFormula;
                            if (typeof expectedFormula !== "string" || !expectedFormula.startsWith("=")) {
                                throw new Error("작성한 기준 수식을 확인하지 못했습니다.");
                            }
                        }
                        var errors = part.valueTypes.filter(function (row) { return row[0] === "Error"; }).length;
                        if (errors) throw new Error("계산 결과에 Excel 오류가 " + errors + "개 있습니다.");
                        completed += count;
                        if (progress) progress("수식 계산 확인", completed, total);
                    }
                }
                if (evidence) await evidence(context, sheet, targets, true);
                // 모든 결과 계산을 마친 뒤 고정해야 뒤 수식이 앞 결과를 참조할 수 있다.
                for (var index = 0; index < targets.length; index++) {
                    var target = targets[index];
                    for (var offset = 0; offset < target.rowCount; offset += batchSize) {
                        var count = Math.min(batchSize, target.rowCount - offset);
                        var part = sheet.getRangeByIndexes(target.rowIndex + offset, target.columnIndex, count, 1);
                        part.load("address,formulasR1C1,valueTypes");
                        await context.sync();
                        activeRange = part.address;
                        if (part.formulasR1C1.some(function (row) { return row[0] !== expectedFormulas[index]; })) {
                            throw new Error("결과를 저장하기 전에 수식이나 셀 값이 바뀌었습니다. 결과를 확인하세요.");
                        }
                        if (part.valueTypes.some(function (row) { return row[0] === "Error"; })) {
                            throw new Error("계산 결과에 Excel 오류가 있어 값으로 저장하지 않았습니다.");
                        }
                        // Excel의 값 붙여넣기로 자료형과 '='로 시작하는 문자열도 그대로 보존한다.
                        part.copyFrom(part, "Values");
                        var remaining = part.getSpecialCellsOrNullObject("Formulas");
                        await context.sync();
                        if (!remaining.isNullObject) throw new Error("결과 범위에 수식이 남아 있어 값 저장을 완료하지 못했습니다.");
                        frozen += count;
                        if (progress) progress("결과값 저장", frozen, total);
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
            error.message = (attempted ? "일부 결과값 또는 수식이 남아 있을 수 있습니다. " : "셀을 변경하지 않았습니다. ") +
                "계산 확인 완료 " + completed + "셀 · 값 저장 완료 " + frozen + "셀 · 확인할 범위: " + activeRange + ". " + error.message;
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
