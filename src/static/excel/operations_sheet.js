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
            return {column_id: column.id, header: column.name, column_index: body.columnIndex + column.index};
        });
        var identity = columns.find(function (column) { return column.column_id === workspace.source_row_column_id; });
        if (!identity) throw new Error("원본 행 번호 열이 없습니다. 작업 시트를 확인하세요.");
        return {sheet: sheet, table: table, body: body, columns: columns, identity: identity,
            stamp: JSON.stringify([body.rowIndex, body.columnIndex, body.rowCount, columns])};
    }
    async function chunk(context, info, start, count, columns) {
        var ranges = columns.map(function (column) {
            var range = info.sheet.getRangeByIndexes(start, column.column_index, count, 1);
            range.load("text"); return range;
        });
        var ids = info.sheet.getRangeByIndexes(start, info.identity.column_index, count, 1);
        ids.load("values");
        await context.sync();
        return ids.values.map(function (row, index) {
            return {excel_row: start + index + 1, identity: row[0],
                values: ranges.map(function (range) { return range.text[index][0]; })};
        });
    }
    function selectedColumns(info, ids) {
        return ids.map(function (id) {
            var column = info.columns.find(function (item) { return String(item.column_id) === String(id); });
            if (!column || column.column_id === info.identity.column_id) throw new Error("대상 열이 없습니다. 범위를 다시 선택하세요.");
            return column;
        });
    }
    async function read(workspace, target, ids, progress, cancelled) {
        window.workspaceSheet.requireExcel("1.9");
        return Excel.run(async function (context) {
            var info = await layout(context, workspace);
            var columns = selectedColumns(info, ids);
            if (target.row_count < 1 || target.row_count > 400000 || target.row_start < info.body.rowIndex ||
                target.row_start + target.row_count > info.body.rowIndex + info.body.rowCount) {
                throw new Error("현재 행 범위를 다시 선택하세요.");
            }
            if (target.row_count * columns.length > 2000000) throw new Error("한 번에 최대 200만 셀을 읽습니다. 대상 행을 줄여 주세요.");
            var rows = [];
            for (var offset = 0; offset < target.row_count; offset += batchSize) {
                cancelled();
                var part = await chunk(context, info, target.row_start + offset,
                    Math.min(batchSize, target.row_count - offset), columns);
                part.forEach(function (row) { rows.push(row); });
                progress("현재 값 읽기", rows.length, target.row_count);
            }
            cancelled();
            if ((await layout(context, workspace)).stamp !== info.stamp) throw new Error("읽는 동안 표 구성이 바뀌었습니다.");
            return {workspace: workspace, columns: columns, rows: rows, stamp: info.stamp, row_start: target.row_start,
                output_columns: info.columns.filter(function (item) { return item.column_id !== info.identity.column_id; })};
        });
    }
    function equalRows(expected, actual, offset) {
        return actual.every(function (row, index) {
            var before = expected[offset + index];
            return before && row.excel_row === before.excel_row && row.identity === before.identity &&
                JSON.stringify(row.values) === JSON.stringify(before.values);
        });
    }
    async function verify(context, info, snapshot, progress) {
        var columns = selectedColumns(info, snapshot.columns.map(function (item) { return item.column_id; }));
        for (var offset = 0; offset < snapshot.rows.length; offset += batchSize) {
            var rows = await chunk(context, info, snapshot.row_start + offset,
                Math.min(batchSize, snapshot.rows.length - offset), columns);
            if (!equalRows(snapshot.rows, rows, offset)) throw new Error("값이나 행 순서가 바뀌었습니다. 미리보기를 다시 만드세요.");
            progress("현재 값 재확인", offset + rows.length, snapshot.rows.length);
        }
    }
    async function write(snapshot, values, names, output, progress) {
        if (values.length !== snapshot.rows.length || !names.length || names.length > 100 ||
            values.some(function (row) { return row.length !== names.length || row.some(function (v) {
                return typeof v !== "string" || v.length > 32767;
            }); })) throw new Error("출력 결과의 크기나 값이 올바르지 않습니다.");
        return Excel.run(async function (context) {
            var info = await layout(context, snapshot.workspace);
            if (info.stamp !== snapshot.stamp) throw new Error("표 구성이 바뀌었습니다. 미리보기를 다시 만드세요.");
            await verify(context, info, snapshot, progress);
            info = await layout(context, snapshot.workspace);
            if (info.stamp !== snapshot.stamp) throw new Error("표 구성이 바뀌었습니다.");
            var anchor = info.columns.findIndex(function (c) { return String(c.column_id) === output.anchor; });
            if (anchor < 0 || info.columns[anchor].column_id === info.identity.column_id) throw new Error("결과 위치를 확인하세요.");
            var index = anchor + (output.side === "before" ? 0 : 1);
            if (info.body.columnIndex + info.body.columnCount + names.length > 16384 ||
                info.columns.length - 1 + names.length > 200) throw new Error("작업 표는 최대 200열입니다. 결과 열 수를 줄여 주세요.");
            // 삽입 시 오른쪽 셀을 밀어 덮지 않도록 표 옆 공간도 확인한다.
            var tableRange = info.table.getRange();
            tableRange.load("rowIndex,rowCount"); await context.sync();
            var adjacent = info.sheet.getRangeByIndexes(tableRange.rowIndex,
                info.body.columnIndex + info.body.columnCount, tableRange.rowCount, names.length).getUsedRangeOrNullObject();
            adjacent.load("address"); await context.sync();
            if (!adjacent.isNullObject) throw new Error("작업 표 오른쪽에 사용 중인 셀이 있습니다. 먼저 공간을 확보하세요.");
            var used = new Set(info.columns.map(function (c) { return c.header.toLowerCase(); }));
            names = names.map(function (name) {
                var base = name.trim().slice(0, 220);
                if (!base) throw new Error("결과 열 이름을 입력하세요.");
                name = base;
                for (var n = 2; used.has(name.toLowerCase()); n++) name = base + " " + n;
                used.add(name.toLowerCase()); return name;
            });
            var added = [], started = false;
            try {
                for (var i = 0; i < names.length; i++) {
                    var pending = names[i] + " (작성 중)";
                    while (used.has(pending.toLowerCase())) pending += "_";
                    used.add(pending.toLowerCase());
                    started = true;
                    var column = info.table.columns.add(index + i === info.columns.length + i ? null : index + i, null, pending);
                    column.load("id,index,name"); added.push(column);
                }
                await context.sync();
                info = await layout(context, snapshot.workspace);
                var stamp = info.stamp;
                var inputs = selectedColumns(info, snapshot.columns.map(function (c) { return c.column_id; }));
                var outputStart = info.body.columnIndex + added[0].index;
                for (var offset = 0; offset < values.length; offset += batchSize) {
                    info = await layout(context, snapshot.workspace);
                    if (stamp !== info.stamp) throw new Error("작성 중 표 구성이 바뀌었습니다.");
                    var count = Math.min(batchSize, values.length - offset);
                    var current = await chunk(context, info, snapshot.row_start + offset, count, inputs);
                    if (!equalRows(snapshot.rows, current, offset)) throw new Error("작성 중 값이나 행 순서가 바뀌었습니다.");
                    var range = info.sheet.getRangeByIndexes(snapshot.row_start + offset, outputStart, count, names.length);
                    range.numberFormat = Array.from({length: count}, function () { return names.map(function () { return "@"; }); });
                    range.values = values.slice(offset, offset + count).map(function (row) {
                        return row.map(function (value) { return value ? "'" + value : ""; });
                    });
                    await context.sync(); progress("결과 작성", offset + count, values.length);
                }
                await verify(context, info, snapshot, progress);
                info = await layout(context, snapshot.workspace);
                if (stamp !== info.stamp) throw new Error("작성 중 표 구성이 바뀌었습니다.");
                added.forEach(function (column, i) { column.name = names[i]; column.load("name"); });
                var result = info.sheet.getRangeByIndexes(snapshot.row_start, outputStart, values.length, names.length);
                result.load("address"); info.sheet.activate(); result.select(); await context.sync();
                return {columns: added.map(function (column, i) {
                    return {column_id: column.id, column_index: outputStart + i, header: column.name,
                        role: "result", description: "사용자가 확인한 처리 결과"};
                }), address: result.address, row_start: snapshot.row_start, row_count: values.length};
            } catch (error) {
                if (started) error.message = "결과 열이 일부 작성되었을 수 있습니다. ‘작성 중’ 열을 확인하세요. 자동 재시도하지 않습니다. " + error.message;
                throw error;
            }
        });
    }
    window.operationsSheet = {read: read, write: write, layout: layout};
})();
