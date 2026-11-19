"use strict";
(function () {
    var table = window.workspaceTable, batchSize = table.batchSize;
    function matches(value, filter) {
        if (!filter) return true;
        value = String(value); var wanted = String(filter.value || '');
        if (filter.operator === 'equals') return value === wanted;
        if (filter.operator === 'not_equals') return value !== wanted;
        if (filter.operator === 'contains') return value.includes(wanted);
        if (filter.operator === 'blank') return !value.trim();
        if (filter.operator === 'not_blank') return !!value.trim();
        throw new Error('지원하지 않는 행 조건입니다.');
    }
    function filterColumns(filter) {
        if (!filter) return [];
        if (filter.column_id) return [filter.column_id];
        if (!Array.isArray(filter.steps) || !filter.steps.length) throw new Error('작업 범위 조건을 다시 지정하세요.');
        return Array.from(new Set(filterColumns(filter.base).concat(filter.steps.flatMap(function (step) {
            if (!['include', 'exclude'].includes(step.mode) || !step.condition || !step.condition.column_id) throw new Error('지원하지 않는 범위 결합입니다.');
            return [step.condition.column_id];
        }))));
    }
    function compileFilter(filter) {
        filterColumns(filter);
        if (!filter) return function () { return true; };
        if (filter.column_id) return function (value) { return matches(value(filter.column_id), filter); };
        var base = compileFilter(filter.base), ids = filter.base_ids === null || filter.base_ids === undefined ? null : new Set(filter.base_ids);
        return function (value, identity) {
            var selected = (!ids || ids.has(identity)) && base(value, identity);
            filter.steps.forEach(function (step) {
                var matched = matches(value(step.condition.column_id), step.condition);
                selected = step.mode === 'include' ? selected || matched : selected && !matched;
            });
            return selected;
        };
    }
    function filterKey(filter) {
        if (!filter) return 'null';
        if (filter.column_id) return JSON.stringify([filter.column_id, filter.operator, filter.value || '']);
        return JSON.stringify([filterKey(filter.base), filter.steps.map(function (step) {
            return [step.mode, filterKey(step.condition)];
        }), filter.base_ids == null ? null : filter.base_ids.slice().sort(function (a, b) { return a - b; })]);
    }
    function describeFilter(filter, columns) {
        if (!filter) return '전체 행';
        if (!filter.column_id) return '(' + describeFilter(filter.base, columns) + (filter.base_ids == null ? '' : ' · 기존 행 범위') + ')' +
            filter.steps.map(function (step) { return (step.mode === 'include' ? ' + 포함: ' : ' − 제외: ') + describeFilter(step.condition, columns); }).join('');
        var column = columns.find(function (c) { return String(c.column_id) === filter.column_id; });
        var labels = {equals: '같음', not_equals: '다름', contains: '포함', blank: '빈칸', not_blank: '빈칸 아님'};
        return (column ? column.header : '삭제된 열') + ' · ' + labels[filter.operator] +
            (['blank', 'not_blank'].includes(filter.operator) ? '' : ' · ' + JSON.stringify(filter.value));
    }
    function runs(rows) {
        var result = [];
        rows.forEach(function (row, index) {
            var last = result[result.length - 1];
            if (!last || last.count >= batchSize || row.excel_row !== rows[index - 1].excel_row + 1) {
                result.push({offset: index, start: row.excel_row - 1, count: 1});
            } else last.count++;
        });
        return result;
    }
    function blocks(rows, size) {
        var result = [];
        rows.forEach(function (row, index) {
            var last = result[result.length - 1];
            if (!last || row.excel_row - 1 - last.start >= size) result.push({offset: index, start: row.excel_row - 1, count: 1, selected: 1});
            else { last.count = row.excel_row - last.start; last.selected++; }
        });
        return result;
    }
    async function scope(context, info, target, filter, progress, check, ownChanges, limit, identityFilter, condition) {
        if (target.row_count < 1 || target.row_count > 400000 || target.row_start < info.body.rowIndex ||
            target.row_start + target.row_count > info.body.rowIndex + info.body.rowCount) {
            throw new Error('현재 행 범위를 다시 선택하세요.');
        }
        var filterIds = Array.from(new Set(filterColumns(filter).concat(filterColumns(condition))));
        var accepts = compileFilter(filter), acceptsCondition = compileFilter(condition);
        var columns = table.selectedColumns(info, filterIds);
        var rows = [], seen = new Set(), rangeIds = target.row_start === info.body.rowIndex && target.row_count === info.body.rowCount ? null : [];
        for (var offset = 0; offset < target.row_count; offset += batchSize) {
            check();
            var part = await table.chunk(context, info, target.row_start + offset,
                Math.min(batchSize, target.row_count - offset), columns);
            part.forEach(function (row) {
                if (!Number.isSafeInteger(row.identity) || row.identity < 1 || seen.has(row.identity)) {
                    throw new Error('원본 행 식별값이 없거나 중복되었습니다. 추가·복사한 행을 확인하세요.');
                }
                seen.add(row.identity);
                if (rangeIds) rangeIds.push(row.identity);
                function filterValue(id) {
                    var value = row.values[filterIds.indexOf(id)];
                    var own = ownChanges && ownChanges.get(row.identity);
                    if (own && own.column_id === id) {
                        if (value !== own.after) throw new Error('작성 중 조건 열의 값이 바뀌었습니다. 결과를 확인하세요.');
                        value = own.before;
                    }
                    return value;
                }
                var value = filter && filter.column_id ? filterValue(filter.column_id) : '', conditionValue = condition ? filterValue(condition.column_id) : '';
                if ((!limit || rows.length < limit) && (!identityFilter || identityFilter.has(row.identity)) &&
                    accepts(filterValue, row.identity) && acceptsCondition(filterValue, row.identity)) {
                    var selected = {excel_row: row.excel_row, identity: row.identity, filter_value: value, filter_values: filterIds.map(filterValue)};
                    if (condition) selected.condition_value = conditionValue;
                    rows.push(selected);
                }
            });
            progress('행 조건 확인', offset + part.length, target.row_count);
            if (limit && rows.length >= limit) break;
        }
        rows.range_ids = rangeIds;
        return rows;
    }
    async function readRows(context, info, selected, ids, outputId, progress, check) {
        var columns = table.selectedColumns(info, ids), rows = [];
        var output = outputId ? table.selectedColumns(info, [outputId])[0] : null;
        for (var run of blocks(selected, Math.max(1, Math.min(batchSize, Math.floor(20000 / Math.max(1, ids.length)))))) {
            check();
            var part = await table.chunk(context, info, run.start, run.count, columns);
            var destination;
            if (output) {
                destination = info.sheet.getRangeByIndexes(run.start, output.column_index, run.count, 1);
                destination.load('text,formulas'); await context.sync();
            }
            selected.slice(run.offset, run.offset + run.selected).forEach(function (chosen) {
                var i = chosen.excel_row - 1 - run.start, row = part[i];
                if (row.identity !== chosen.identity) throw new Error('읽는 동안 행 순서가 바뀌었습니다. 다시 확인하세요.');
                if (destination) {
                    if (String(destination.formulas[i][0]).startsWith('=')) throw new Error('기존 수식 셀은 값으로 덮어쓰지 않습니다. 다른 결과 열을 선택하세요.');
                    row.destination = destination.text[i][0];
                }
                rows.push(row);
            });
            progress('현재 값 읽기', rows.length, selected.length);
        }
        return rows;
    }
    async function read(workspace, target, ids, progress, check, outputId, limit, identities, condition, allowEmpty) {
        window.workspaceSheet.requireExcel('1.9');
        progress = progress || function () {}; check = check || function () {};
        return Excel.run(async function (context) {
            var info = await table.layout(context, workspace);
            var filter = workspace.row_filter ? JSON.parse(JSON.stringify(workspace.row_filter)) : null;
            condition = condition ? Object.assign({}, condition) : null;
            var identityFilter = identities ? new Set(identities) : null;
            var selected = await scope(context, info, target, filter, progress, check, null, limit, identityFilter, condition);
            if (identityFilter && selected.length !== identityFilter.size) throw new Error("선택한 묶음의 행이 삭제되었거나 범위에서 빠졌습니다. 현재 값을 다시 불러오세요.");
            if (!selected.length && !allowEmpty) throw new Error('조건에 맞는 행이 없습니다. 작업 범위를 바꿔 주세요.');
            if (selected.length * ids.length > 2000000) throw new Error('한 번에 최대 200만 셀을 읽습니다. 대상 행이나 열을 줄여 주세요.');
            var rows = await readRows(context, info, selected, ids, outputId, progress, check);
            if ((await table.layout(context, workspace)).stamp !== info.stamp) throw new Error('읽는 동안 표 구성이 바뀌었습니다.');
            check();
            return {workspace: workspace, target: {row_start: target.row_start, row_count: target.row_count},
                identity_filter: identities || null, row_filter: filter, condition: condition, scope_rows: selected, range_ids: selected.range_ids, columns: table.selectedColumns(info, ids), rows: rows,
                stamp: info.stamp, row_start: target.row_start, output_column_id: outputId || null,
                output_columns: info.columns.filter(function (c) { return c.column_id !== info.identity.column_id; })};
        });
    }
    async function verify(context, info, snapshot, expected, ownChanges, progress) {
        var selected = await scope(context, info, snapshot.target, snapshot.row_filter, progress, function () {}, ownChanges, null, snapshot.identity_filter ? new Set(snapshot.identity_filter) : null, snapshot.condition);
        if (JSON.stringify(selected) !== JSON.stringify(snapshot.scope_rows)) throw new Error('조건에 맞는 행이나 행 순서가 바뀌었습니다. 미리보기를 다시 만드세요.');
        var rows = await readRows(context, info, selected, snapshot.columns.map(function (c) { return String(c.column_id); }),
            snapshot.output_column_id, progress, function () {});
        if (JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error('입력값 또는 기존 결과값이 바뀌었습니다. 미리보기를 다시 만드세요.');
    }
    async function write(snapshot, values, names, output, progress, formats, beforeWrite) {
        if (values.length !== snapshot.rows.length || !names.length || names.length > 100 ||
            values.some(function (row) { return row.length !== names.length || row.some(function (v) {
                return typeof v === 'string' ? v.length > 32767 : !formats || !(typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v));
            }); })) throw new Error('출력 결과의 크기나 값이 올바르지 않습니다.');
        if (formats && (output.mode === 'existing' || formats.length !== values.length || formats.some(function (row) {
            return row.length !== names.length || row.some(function (value) { return typeof value !== 'string'; });
        }))) throw new Error('원본 열의 표시 형식을 확인할 수 없습니다.');
        var existing = output.mode === 'existing';
        if (existing && (names.length !== 1 || output.column_id !== snapshot.output_column_id)) {
            throw new Error('기존 결과 열이 바뀌었습니다. 미리보기를 다시 만드세요.');
        }
        if (JSON.stringify(snapshot.row_filter) !== JSON.stringify(snapshot.workspace.row_filter || null)) {
            throw new Error('작업 조건이 바뀌었습니다. 미리보기를 다시 만드세요.');
        }
        return Excel.run(async function (context) {
            var info = await table.layout(context, snapshot.workspace);
            if (info.stamp !== snapshot.stamp) throw new Error('표 구성이 바뀌었습니다. 미리보기를 다시 만드세요.');
            var expected = snapshot.rows.map(function (row) { return Object.assign({}, row, {values: row.values.slice()}); });
            var ownChanges = new Map(), added = [], outputs = [], started = false;
            await verify(context, info, snapshot, expected, ownChanges, progress);
            info = await table.layout(context, snapshot.workspace);
            if (info.stamp !== snapshot.stamp) throw new Error('표 구성이 바뀌었습니다. 미리보기를 다시 만드세요.');
            if (existing) {
                outputs = table.selectedColumns(info, [output.column_id]);
            } else {
                var anchor = info.columns.findIndex(function (c) { return String(c.column_id) === output.anchor; });
                if (anchor < 0 || info.columns[anchor].column_id === info.identity.column_id) throw new Error('결과 위치를 확인하세요.');
                var index = anchor + (output.side === 'before' ? 0 : 1);
                if (info.body.columnIndex + info.body.columnCount + names.length > 16384 || info.columns.length - 1 + names.length > 200) {
                    throw new Error('작업 표는 최대 200열입니다. 결과 열 수를 줄여 주세요.');
                }
                var tableRange = info.table.getRange(); tableRange.load('rowIndex,rowCount'); await context.sync();
                var adjacent = info.sheet.getRangeByIndexes(tableRange.rowIndex,
                    info.body.columnIndex + info.body.columnCount, tableRange.rowCount, names.length).getUsedRangeOrNullObject();
                adjacent.load('address'); await context.sync();
                if (!adjacent.isNullObject) throw new Error('작업 표 오른쪽에 사용 중인 셀이 있습니다. 먼저 공간을 확보하세요.');
                var used = new Set(info.columns.map(function (c) { return c.header.toLowerCase(); }));
                names = names.map(function (name) {
                    var base = name.trim().slice(0, 220);
                    if (!base) throw new Error('결과 열 이름을 입력하세요.');
                    name = base;
                    for (var n = 2; used.has(name.toLowerCase()); n++) name = base + ' ' + n;
                    used.add(name.toLowerCase()); return name;
                });
            }
            try {
                if (!existing) {
                    for (var i = 0; i < names.length; i++) {
                        var pending = names[i] + ' (작성 중)';
                        while (used.has(pending.toLowerCase())) pending += '_';
                        used.add(pending.toLowerCase()); started = true;
                        var column = info.table.columns.add(index + i === info.columns.length + i ? null : index + i, null, pending);
                        column.load('id,index,name'); added.push(column);
                    }
                    await context.sync();
                    info = await table.layout(context, snapshot.workspace);
                    outputs = table.selectedColumns(info, added.map(function (c) { return String(c.id); }));
                }
                if (beforeWrite) await beforeWrite(context, info, outputs);
                var stamp = info.stamp;
                for (var run of blocks(snapshot.rows, Math.max(1, Math.min(batchSize, Math.floor(20000 / names.length))))) {
                    info = await table.layout(context, snapshot.workspace);
                    if (stamp !== info.stamp) throw new Error('작성 중 표 구성이 바뀌었습니다.');
                    var before = await readRows(context, info, snapshot.scope_rows.slice(run.offset, run.offset + run.selected),
                        snapshot.columns.map(function (c) { return String(c.column_id); }), snapshot.output_column_id, function () {}, function () {});
                    if (JSON.stringify(before) !== JSON.stringify(expected.slice(run.offset, run.offset + run.selected))) throw new Error('작성 중 값이나 행 순서가 바뀌었습니다.');
                    for (var part of runs(snapshot.rows.slice(run.offset, run.offset + run.selected))) {
                        outputs.forEach(function (column, j) {
                            var range = info.sheet.getRangeByIndexes(part.start, column.column_index, part.count, 1);
                            var first = run.offset + part.offset, stop = first + part.count;
                            range.numberFormat = formats ? formats.slice(first, stop).map(function (row) { return [row[j]]; }) :
                                Array.from({length: part.count}, function () { return ['@']; });
                            range.values = values.slice(first, stop).map(function (row) {
                                return [typeof row[j] === 'string' && row[j] ? "'" + row[j] : row[j]];
                            });
                        });
                    }
                    started = true; await context.sync();
                    if (existing) for (var k = run.offset; k < run.offset + run.selected; k++) {
                        expected[k].destination = values[k][0];
                        snapshot.columns.forEach(function (column, j) {
                            if (String(column.column_id) === output.column_id) expected[k].values[j] = values[k][0];
                        });
                        var filterIds = Array.from(new Set(filterColumns(snapshot.row_filter).concat(filterColumns(snapshot.condition))));
                        if (filterIds.includes(output.column_id)) {
                            ownChanges.set(expected[k].identity, {column_id: output.column_id,
                                before: snapshot.scope_rows[k].filter_values[filterIds.indexOf(output.column_id)], after: values[k][0]});
                        }
                    }
                    progress('결과 작성', run.offset + run.selected, values.length);
                }
                info = await table.layout(context, snapshot.workspace);
                if (stamp !== info.stamp) throw new Error('작성 중 표 구성이 바뀌었습니다.');
                await verify(context, info, snapshot, expected, ownChanges, progress);
                if ((await table.layout(context, snapshot.workspace)).stamp !== stamp) throw new Error('작성 중 표 구성이 바뀌었습니다.');
                added.forEach(function (column, i) { column.name = names[i]; column.load('name'); });
                info.sheet.activate();
                info.sheet.getRangeByIndexes(snapshot.rows[0].excel_row - 1, outputs[0].column_index, 1, 1).select();
                await context.sync();
                return {columns: outputs.map(function (column, i) {
                    var old = snapshot.workspace.columns.find(function (c) { return String(c.column_id) === String(column.column_id); });
                    return Object.assign({}, old || {}, column, {header: existing ? column.header : added[i].name,
                        role: old ? old.role : 'result', description: old ? old.description : '사용자가 확인한 처리 결과'});
                }), row_start: snapshot.target.row_start, row_count: values.length, range_row_count: snapshot.target.row_count};
            } catch (error) {
                if (started) error.message = '결과가 일부 반영됐을 수 있습니다. 해당 열을 확인하세요. 자동 재시도하지 않습니다. ' + error.message;
                throw error;
            }
        });
    }
    window.operationsSheet = {read: read, write: write, matches: matches, filterColumns: filterColumns, compileFilter: compileFilter, filterKey: filterKey, describeFilter: describeFilter};
})();
