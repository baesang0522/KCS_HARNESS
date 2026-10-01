"use strict";

(function () {
    var batchSize = 1000;

    async function layout(context, workspace) {
        var sheet = context.workbook.worksheets.getItem(workspace.worksheet_id);
        var table = sheet.tables.getItem(workspace.table_id);
        var body = table.getDataBodyRange();
        sheet.load("name");
        body.load("rowIndex,columnIndex,rowCount,columnCount");
        table.columns.load("items/id,items/name,items/index");
        await context.sync();
        var columns = table.columns.items.map(function (column) {
            return {column_id: column.id, header: column.name,
                column_index: body.columnIndex + column.index};
        });
        var identity = columns.find(function (column) {
            return column.column_id === workspace.source_row_column_id;
        });
        if (!identity) throw new Error("원본 행 번호 열이 없습니다. 작업 시트를 다시 확인하세요.");
        return {sheet: sheet, table: table, body: body, columns: columns,
            identity: identity, stamp: JSON.stringify([
                body.rowIndex, body.columnIndex, body.rowCount, columns
            ])};
    }

    async function readChunk(context, info, start, count, columnIndex) {
        var cells = info.sheet.getRangeByIndexes(start, columnIndex, count, 1);
        var ids = info.sheet.getRangeByIndexes(start, info.identity.column_index, count, 1);
        cells.load("text");
        ids.load("values");
        await context.sync();
        return cells.text.map(function (row, index) {
            return {excel_row: start + index + 1, value: row[0], identity: ids.values[index][0]};
        });
    }

    async function read(workspace, target, column, progress, checkCancelled) {
        window.normalizationSheet.requireExcel("1.9");
        return Excel.run(async function (context) {
            var info = await layout(context, workspace);
            var current = info.columns.find(function (item) {
                return item.column_id === column.column_id;
            });
            if (!current || current.header !== column.header ||
                current.column_index !== column.column_index) {
                throw new Error("작업 표 안의 열을 범위 다시 선택으로 가져오세요. 열 위치나 이름이 바뀌었을 수도 있습니다.");
            }
            if (target.row_start < info.body.rowIndex || target.row_count < 1 ||
                target.row_start + target.row_count > info.body.rowIndex + info.body.rowCount) {
                throw new Error("행 범위가 작업 표를 벗어납니다. 범위를 다시 선택하세요.");
            }
            var rows = [];
            for (var offset = 0; offset < target.row_count; offset += batchSize) {
                checkCancelled();
                var chunk = await readChunk(context, info, target.row_start + offset,
                    Math.min(batchSize, target.row_count - offset), current.column_index);
                chunk.forEach(function (row) { rows.push(row); });
                progress(rows.length, target.row_count);
            }
            checkCancelled();
            if ((await layout(context, workspace)).stamp !== info.stamp) {
                throw new Error("읽는 동안 표 구성이 바뀌었습니다. 다시 확인하세요.");
            }
            return {workspace: workspace, column: current, columns: info.columns.filter(function (item) {
                return item.column_id !== workspace.source_row_column_id;
            }), rows: rows, stamp: info.stamp, row_start: target.row_start};
        });
    }

    function sameRows(expected, actual, offset) {
        return actual.every(function (row, index) {
            var before = expected[offset + index];
            return row.excel_row === before.excel_row && row.value === before.value &&
                row.identity === before.identity;
        });
    }

    async function verify(context, info, snapshot, columnIndex, progress) {
        for (var offset = 0; offset < snapshot.rows.length; offset += batchSize) {
            var current = await readChunk(context, info, snapshot.row_start + offset,
                Math.min(batchSize, snapshot.rows.length - offset), columnIndex);
            if (!sameRows(snapshot.rows, current, offset)) {
                throw new Error("값이나 행 순서가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
            }
            progress("현재 값 재확인", offset + current.length, snapshot.rows.length);
        }
    }

    async function pickAnchor(workspace) {
        return Excel.run(async function (context) {
            var selected = context.workbook.getSelectedRange();
            selected.load("columnIndex,columnCount");
            selected.worksheet.load("id");
            var info = await layout(context, workspace);
            var column = info.columns.find(function (item) {
                return item.column_index === selected.columnIndex;
            });
            if (selected.worksheet.id !== workspace.worksheet_id || selected.columnCount !== 1 ||
                !column || column.column_id === workspace.source_row_column_id) {
                throw new Error("작업 표에서 기준으로 삼을 열의 셀 하나를 선택하세요.");
            }
            return column.column_id;
        });
    }

    async function write(snapshot, values, output, progress) {
        return Excel.run(async function (context) {
            var workspace = snapshot.workspace;
            var info = await layout(context, workspace);
            if (info.stamp !== snapshot.stamp) {
                throw new Error("표 구성이 바뀌었습니다. 범위를 다시 선택하고 변경 내용을 확인하세요.");
            }
            // 승인한 값과 현재 값·행 순서가 같아야 쓰기 시작한다.
            await verify(context, info, snapshot, snapshot.column.column_index, progress);
            info = await layout(context, workspace);
            if (info.stamp !== snapshot.stamp) throw new Error("표 구성이 바뀌었습니다. 다시 확인하세요.");
            var anchorIndex = info.columns.findIndex(function (column) {
                return String(column.column_id) === output.anchor;
            });
            if (anchorIndex < 0 || info.columns[anchorIndex].column_id === workspace.source_row_column_id) {
                throw new Error("결과 위치를 다시 선택하세요.");
            }
            var insertIndex = anchorIndex + (output.side === "after" ? 1 : 0);
            if (info.body.columnIndex + info.body.columnCount >= 16384) {
                throw new Error("새 결과 열을 만들 공간이 없습니다.");
            }
            // 표 끝에 붙일 때 표 밖의 기존 데이터가 흡수되지 않도록 확인한다.
            if (insertIndex === info.columns.length) {
                var tableRange = info.table.getRange();
                tableRange.load("rowIndex,rowCount");
                await context.sync();
                var adjacent = info.sheet.getRangeByIndexes(tableRange.rowIndex,
                    info.body.columnIndex + info.body.columnCount, tableRange.rowCount, 1)
                    .getUsedRangeOrNullObject();
                adjacent.load("address");
                await context.sync();
                if (!adjacent.isNullObject) {
                    throw new Error("표 바로 오른쪽에 사용 중인 셀이 있습니다. 표 안의 다른 결과 위치를 선택하세요.");
                }
            }
            var name = output.name.trim();
            if (!name) throw new Error("결과 열 이름을 입력하세요.");
            var usedNames = new Set(info.columns.map(function (column) { return column.header.toLowerCase(); }));
            var base = name;
            for (var number = 2; usedNames.has(name.toLowerCase()); number += 1) name = base + " " + number;
            var pendingName = name + " (작성 중)";
            while (usedNames.has(pendingName.toLowerCase())) pendingName += "_";
            var started = false;
            try {
                var added = info.table.columns.add(
                    insertIndex === info.columns.length ? null : insertIndex, null, pendingName
                );
                started = true;
                added.load("id,index,name");
                await context.sync();
                info = await layout(context, workspace);
                var source = info.columns.find(function (column) {
                    return column.column_id === snapshot.column.column_id;
                });
                var outputIndex = info.body.columnIndex + added.index;
                var writingStamp = info.stamp;
                for (var start = 0; start < values.length; start += batchSize) {
                    info = await layout(context, workspace);
                    if (info.stamp !== writingStamp) throw new Error("작성 중 표 구성이 바뀌었습니다.");
                    var count = Math.min(batchSize, values.length - start);
                    var actual = await readChunk(context, info, snapshot.row_start + start, count, source.column_index);
                    if (!sameRows(snapshot.rows, actual, start)) throw new Error("작성 중 값이나 행 순서가 바뀌었습니다.");
                    var range = info.sheet.getRangeByIndexes(snapshot.row_start + start, outputIndex, count, 1);
                    range.numberFormat = Array.from({length: count}, function () { return ["@"]; });
                    range.values = values.slice(start, start + count).map(function (value) {
                        return [value === "" ? "" : "'" + value];
                    });
                    await context.sync();
                    progress("작성", start + count, values.length);
                }
                // 앞서 쓴 구간의 원본을 사용자가 나중에 바꾼 경우도 완료로 처리하지 않는다.
                await verify(context, info, snapshot, source.column_index, progress);
                info = await layout(context, workspace);
                if (info.stamp !== writingStamp) throw new Error("작성 중 표 구성이 바뀌었습니다.");
                added.name = name;
                var resultRange = info.sheet.getRangeByIndexes(snapshot.row_start, outputIndex, values.length, 1);
                resultRange.load("address");
                added.load("name");
                info.sheet.activate();
                resultRange.select();
                await context.sync();
                return {column_id: added.id, column_index: outputIndex, header: added.name,
                    role: "result", description: snapshot.column.header + "의 전처리·치환 결과",
                    sheet_name: info.sheet.name, address: resultRange.address};
            } catch (error) {
                if (started) {
                    error.partial = true;
                    error.message = "새 결과 열이 일부 작성되었을 수 있습니다. 시트의 ‘" +
                        pendingName + "’ 열을 확인하세요. " + error.message;
                }
                throw error;
            }
        });
    }

    window.normalizationTransformSheet = {read: read, write: write, pickAnchor: pickAnchor};
})();
