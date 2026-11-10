"use strict";
(function () {
    // 작업표 상태는 workspace 컨트롤러 소유이며, 호출 시 현재 상태를 읽는다.
    window.createWorkspaceFormula = function (options) {
        return {
            formulaTarget: async function (scope, fromSelection) {
                var workspace = options.getWorkspace();
                var target = options.getTarget();
                var lastFormula = options.getLastFormula();
                if (!workspace) {
                    if (!fromSelection && scope && scope.workspace_id) throw new Error("요청한 작업 표를 다시 열어주세요.");
                    return fromSelection ? null : lastFormula;
                }
                var chosen = null;
                if (fromSelection) {
                    chosen = await window.workspaceSheet.readWorkspaceTarget(workspace, false);
                    if (!chosen) return null;
                    scope = {workspace_id: workspace.workspace_id,
                        column_ids: chosen.columns.map(function (column) { return String(column.column_id); })};
                }
                if (!scope || scope.workspace_id !== workspace.workspace_id || !Array.isArray(scope.column_ids) ||
                    !scope.column_ids.length || scope.column_ids.length > 20 || new Set(scope.column_ids).size !== scope.column_ids.length) {
                    throw new Error("수식에 사용할 작업 표와 입력 열을 다시 지정해 주세요.");
                }
                await options.refresh();
                var columns = scope.column_ids.map(function (id) {
                    var column = workspace.columns.find(function (c) { return String(c.column_id) === id; });
                    if (!column) throw new Error("요청한 수식 입력 열이 삭제되었습니다. 대상을 다시 확인하세요.");
                    return column;
                }).sort(function (a, b) { return a.column_index - b.column_index; });
                return {worksheet_id: workspace.worksheet_id, workspace_id: workspace.workspace_id,
                    table_id: String(workspace.table_id), workspace_task_type: workspace.task_type,
                    row_start: (chosen || target).row_start, row_count: (chosen || target).row_count,
                    column_start: columns[0].column_index,
                    column_count: columns[columns.length - 1].column_index - columns[0].column_index + 1,
                    input_columns: columns.map(function (c) { return {column_id: String(c.column_id),
                        column_index: c.column_index, header: c.header, role: c.role, description: c.description || ""}; })};
            },
            validateFormulaSource: async function (selection) {
                var workspace = options.getWorkspace();
                if (!selection.workspace_id) return;
                if (!workspace || workspace.workspace_id !== selection.workspace_id ||
                    workspace.worksheet_id !== selection.worksheet_id || String(workspace.table_id) !== selection.table_id) {
                    throw new Error("수식 계획의 작업 표가 바뀌었습니다. 다시 요청하세요.");
                }
                await Excel.run(async function (context) {
                    var info = await window.workspaceTable.layout(context, workspace);
                    if (info.sheet.name !== selection.sheet_name || selection.row_start < info.body.rowIndex ||
                        selection.row_start + selection.row_count > info.body.rowIndex + info.body.rowCount ||
                        selection.input_columns.some(function (input) {
                            var current = info.columns.find(function (c) { return String(c.column_id) === input.column_id; });
                            return !current || current.column_index !== input.column_index || current.header !== input.header;
                        })) throw new Error("수식 입력 열이나 행 범위가 바뀌었습니다. 수식을 다시 확인하세요.");
                });
            },
            prepareFormulaOutput: async function (preview, selection) {
                var workspace = options.getWorkspace();
                if (!workspace || workspace.worksheet_id !== selection.worksheet_id) return;
                await Excel.run(async function (context) {
                    var info = await window.workspaceTable.layout(context, workspace);
                    var ranges = preview.plan.actions.map(function (action) {
                        var range = info.sheet.getRange(action.target_range);
                        range.load("rowIndex,rowCount,columnIndex,columnCount"); return range;
                    });
                    await context.sync();
                    var end = Math.max.apply(null, ranges.map(function (r) { return r.columnIndex + r.columnCount; }));
                    var oldEnd = info.body.columnIndex + info.body.columnCount;
                    if (ranges.some(function (r) { return r.rowIndex < info.body.rowIndex ||
                        r.rowIndex + r.rowCount > info.body.rowIndex + info.body.rowCount ||
                        r.columnIndex < info.body.columnIndex + 1; })) throw new Error("수식 결과는 현재 작업 표의 데이터 행에 작성하세요.");
                    if (end - info.body.columnIndex > 201) throw new Error("작업 표는 최대 200개 데이터 열입니다.");
                    if (end <= oldEnd) return;
                    var extension = info.sheet.getRangeByIndexes(info.body.rowIndex - 1, oldEnd, info.body.rowCount + 1, end - oldEnd);
                    var occupied = extension.getUsedRangeOrNullObject(); occupied.load("address"); await context.sync();
                    if (!occupied.isNullObject) throw new Error("수식 결과까지의 공간에 기존 데이터가 있습니다. 작업 표의 빈 열을 선택하세요.");
                    for (var columnIndex = oldEnd; columnIndex < end; columnIndex++) {
                        var actionIndex = ranges.findIndex(function (r) { return r.columnIndex === columnIndex; });
                        var label = actionIndex >= 0 ? preview.plan.actions[actionIndex].output_label : "추가 열";
                        info.table.columns.add(null, null, label + " " + options.newRequestId().slice(0, 6));
                    }
                    await context.sync();
                });
            },
            formulaResultColumns: async function (result, selection) {
                var workspace = options.getWorkspace();
                if (!selection.workspace_id) return [];
                if (!workspace || selection.workspace_id !== workspace.workspace_id) throw new Error("수식 결과의 작업 표가 바뀌었습니다.");
                await options.refresh();
                return result.targets.map(function (range) {
                    var columns = workspace.columns.filter(function (c) { return c.column_index === range.column_start; });
                    if (range.column_count !== 1 || columns.length !== 1) throw new Error("수식 결과 열을 확인하지 못했습니다.");
                    return String(columns[0].column_id);
                });
            }
        };
    };
})();
