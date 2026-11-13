"use strict";
(function () {
    function source(workspace) {
        if (!workspace.source_snapshot) throw new Error('이전 작업표에는 원본 보관본이 없습니다. 열을 추가하려면 원본으로 새 통합 조사를 시작하세요.');
        return workspace.source_snapshot;
    }
    async function liveLayout(context, workspace) {
        var saved = source(workspace), table = window.workspaceTable;
        var backup = await table.layout(context, saved);
        if (backup.body.rowCount !== saved.row_count) throw new Error('원본 보관본의 행 수가 바뀌었습니다.');
        var first = backup.sheet.getRangeByIndexes(backup.body.rowIndex, backup.identity.column_index, 1, 1);
        first.load('values'); await context.sync();
        var rowStart = first.values[0][0] - 2;
        if (!Number.isInteger(rowStart) || rowStart < 0) throw new Error('원본 행 연결을 확인할 수 없습니다.');
        var sheet = context.workbook.worksheets.getItem(workspace.source.worksheet_id);
        var used = sheet.getUsedRangeOrNullObject(true);
        used.load('rowIndex,rowCount,columnIndex,columnCount'); sheet.load('name'); await context.sync();
        if (used.isNullObject || used.columnCount > 200 || used.rowIndex + used.rowCount < rowStart + saved.row_count + 1) {
            throw new Error('원본 시트의 범위가 바뀌었거나 사용 열이 200개를 초과합니다.');
        }
        var headers = sheet.getRangeByIndexes(rowStart, used.columnIndex, 1, used.columnCount);
        headers.load('text'); await context.sync();
        return {sheet: sheet, backup: backup, row_start: rowStart, row_count: saved.row_count,
            columns: headers.text[0].map(function (header, i) {
                var index = used.columnIndex + i;
                return {column_id: 'live:' + index, column_index: index, header: header, origin: 'live'};
            }).filter(function (c) { return c.header.trim(); })};
    }
    function sourceLinks(workspace) {
        var saved = source(workspace);
        return saved.columns.map(function (column) {
            var known = workspace.columns.find(function (c) { return c.source_column_id === String(column.column_id); });
            var index = column.source_column_index != null ? column.source_column_index : known && known.source_column_index;
            return {column_id: String(column.column_id), column_index: index,
                header: column.source_header != null ? column.source_header : known && known.source_header};
        }).filter(function (c) { return Number.isInteger(c.column_index) && typeof c.header === 'string'; });
    }
    async function list(workspace) {
        var saved = source(workspace);
        return Excel.run(async function (context) {
            var info = await window.workspaceTable.layout(context, saved);
            var available = info.columns.filter(function (c) { return String(c.column_id) !== String(saved.source_row_column_id) &&
                !workspace.columns.some(function (known) { return known.source_column_id === String(c.column_id); }); });
            var live = await liveLayout(context, workspace), links = sourceLinks(workspace);
            return available.concat(live.columns.filter(function (c) {
                return !links.some(function (known) { return known.column_index === c.column_index; }) &&
                    !workspace.columns.some(function (known) { return known.source_column_index === c.column_index; });
            }));
        });
    }
    async function readLive(workspace, columnId, options, progress) {
        // shortcut: 원본에는 행 ID가 없어 중복 행 재정렬은 검출할 수 없다. 원본 정렬을 지원할 때 고유 키 연결로 바꾼다.
        if (!options || !options.original_order_confirmed) throw new Error('원본 행을 정렬·추가·삭제하지 않았는지 확인하세요. 작업표 정렬은 괜찮습니다.');
        return Excel.run(async function (context) {
            var live = await liveLayout(context, workspace), table = window.workspaceTable;
            var column = live.columns.find(function (c) { return c.column_id === columnId; });
            if (!column || column.header !== options.header) throw new Error('추가할 원본 열이 바뀌었습니다. 열 목록을 다시 여세요.');
            var links = sourceLinks(workspace);
            if (!links.length) throw new Error('원본과 비교할 보관 열이 없습니다. 원본으로 새 작업을 시작하세요.');
            links.forEach(function (link) {
                if (!live.columns.some(function (c) { return c.column_index === link.column_index && c.header === link.header; })) {
                    throw new Error('원본 열 위치나 이름이 바뀌었습니다. 잘못된 행 연결을 막기 위해 추가를 중단했습니다.');
                }
            });
            var backupColumns = table.selectedColumns(live.backup, links.map(function (c) { return c.column_id; }));
            var valuesById = new Map(), size = Math.max(1, Math.min(1000, Math.floor(20000 / links.length)));
            for (var offset = 0; offset < live.row_count; offset += size) {
                var count = Math.min(size, live.row_count - offset), start = live.row_start + 1 + offset;
                var expected = await table.chunk(context, live.backup, live.backup.body.rowIndex + offset, count, backupColumns);
                var checks = links.map(function (link) {
                    var range = live.sheet.getRangeByIndexes(start, link.column_index, count, 1); range.load('text'); return range;
                });
                var data = live.sheet.getRangeByIndexes(start, column.column_index, count, 1);
                data.load('values,numberFormat'); await context.sync();
                expected.forEach(function (row, i) {
                    if (row.identity !== start + i + 1 || row.values.some(function (value, j) { return value !== checks[j].text[i][0]; })) {
                        throw new Error('원본의 행 순서나 기존 값이 보관본과 다릅니다. 행을 잘못 붙이지 않도록 추가를 중단했습니다.');
                    }
                    valuesById.set(row.identity, {value: data.values[i][0], format: data.numberFormat[i][0]});
                });
                progress('원본 행 대조 및 추가 열 읽기', offset + count, live.row_count);
            }
            return {column: column, valuesById: valuesById};
        });
    }
    async function writeColumn(workspace, valuesById, name, progress) {
        var reader = window.operationsSheet, work = Object.assign({}, workspace, {row_filter: null});
        var bounds = await Excel.run(async function (context) {
            var info = await window.workspaceTable.layout(context, workspace);
            return {row_start: info.body.rowIndex, row_count: info.body.rowCount};
        });
        var target = await reader.read(work, bounds, [String(workspace.columns[0].column_id)], progress, function () {});
        var values = target.rows.map(function (row) {
            if (!valuesById.has(row.identity)) throw new Error('원본과 연결되지 않는 행이 있습니다. 열 추가를 중단했습니다.');
            return [valuesById.get(row.identity).value];
        });
        var formats = target.rows.map(function (row) { return [valuesById.get(row.identity).format]; });
        return reader.write(target, values, [name],
            {mode: 'new', anchor: String(target.output_columns[target.output_columns.length - 1].column_id), side: 'after'}, progress, formats);
    }
    async function append(workspace, columnId, progress, options) {
        if (columnId.startsWith('live:')) {
            var live = await readLive(workspace, columnId, options, progress);
            var added = await writeColumn(workspace, live.valuesById, live.column.header, progress);
            Object.assign(added.columns[0], {source_column_index: live.column.column_index, source_header: live.column.header,
                role: 'reference', description: '원본 시트의 현재 값을 원본 행 번호로 연결해 추가'});
            return added;
        }
        var saved = source(workspace), reader = window.operationsSheet;
        var bounds = await Excel.run(async function (context) {
            var sourceInfo = await window.workspaceTable.layout(context, saved);
            if (sourceInfo.body.rowCount !== saved.row_count) throw new Error('원본 보관본의 행 수가 바뀌었습니다.');
            return {source: {row_start: sourceInfo.body.rowIndex, row_count: sourceInfo.body.rowCount}};
        });
        var original = await reader.read(saved, bounds.source, [columnId], progress, function () {});
        var valuesById = await Excel.run(async function (context) {
            var info = await window.workspaceTable.layout(context, saved), result = new Map();
            if (info.stamp !== original.stamp) throw new Error('원본 보관본의 열 구성이 바뀌었습니다.');
            var column = window.workspaceTable.selectedColumns(info, [columnId])[0];
            for (var offset = 0; offset < original.rows.length; offset += 1000) {
                var count = Math.min(1000, original.rows.length - offset);
                var cells = info.sheet.getRangeByIndexes(bounds.source.row_start + offset, column.column_index, count, 1);
                var keys = info.sheet.getRangeByIndexes(bounds.source.row_start + offset, info.identity.column_index, count, 1);
                cells.load('values,numberFormat'); keys.load('values'); await context.sync();
                cells.values.forEach(function (row, i) {
                    var identity = keys.values[i][0];
                    if (identity !== original.rows[offset + i].identity) throw new Error('원본 보관본의 행 순서가 바뀌었습니다.');
                    result.set(identity, {value: row[0], format: cells.numberFormat[i][0]});
                });
                progress('원본 값과 표시 형식 읽기', offset + count, original.rows.length);
            }
            return result;
        });
        var result = await writeColumn(workspace, valuesById, original.columns[0].header, progress);
        result.columns[0].source_column_id = columnId;
        var link = sourceLinks(workspace).find(function (c) { return c.column_id === columnId; });
        if (link) Object.assign(result.columns[0], {source_column_index: link.column_index, source_header: link.header});
        result.columns[0].role = 'reference';
        result.columns[0].description = '조사 시작 당시 원본 보관본에서 가져온 값과 표시 형식';
        return result;
    }
    window.sourceColumns = {list: list, append: append};
})();
