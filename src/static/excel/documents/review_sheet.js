"use strict";
(function () {
    var headers = {supplier: ['그룹명', '회사명', '근거 페이지'],
        item: ['그룹', 'HS', '규격', '조건', '근거 페이지'], other: ['그룹', '내용', '근거 페이지']};
    var legacySupplierHeaders = ['그룹', '구분', '회사명', '근거 페이지'];
    function key(cid, did) { return 'kcs.pdf-review.' + cid + '.' + did; }
    function canonical(rows) {
        var suppliers = [], other = [];
        rows.forEach(function (row) {
            var t = row.target, fields = t.kind === 'supplier' ? [t.category || t.company_name, t.company_name]
                : t.kind === 'item' ? [t.group, t.hs_codes, t.specification, t.requirements] : [t.group, t.description];
            var value = JSON.stringify([t.kind, fields, row.source_pages.slice().sort(function (a, b) { return a - b; })]);
            (t.kind === 'supplier' ? suppliers : other).push(value);
        });
        return JSON.stringify([suppliers, other.sort()]);
    }
    function values(row) {
        var t = row.target, cells = t.kind === 'supplier' ? [t.category || t.company_name, t.company_name]
            : t.kind === 'item' ? [t.group, t.hs_codes.join(', '), t.specification, t.requirements] : [t.group, t.description];
        return cells.concat([row.source_pages.join(', ')]);
    }
    function parse(kind, rows, legacy, baseline) {
        var originals = new Map();
        (baseline || []).slice().reverse().forEach(function (item) {
            if (item.target.kind !== 'supplier') return;
            var key = JSON.stringify(values(item));
            if (!originals.has(key)) originals.set(key, []);
            originals.get(key).push(item);
        });
        return rows.filter(function (row) { return row.some(function (value) { return String(value).trim(); }); }).map(function (row, index) {
            var cells = row.map(function (value) { return String(value).trim(); });
            var pages = cells[cells.length - 1], sourcePages = [];
            if (pages) {
                if (!/^\d+(\s*[,，]\s*\d+)*$/.test(pages)) throw new Error('근거 페이지는 1 또는 1, 2처럼 입력하세요. (' + (index + 1) + '번째 항목)');
                sourcePages = Array.from(new Set(pages.split(/[,，]/).map(Number)));
                if (sourcePages.some(function (n) { return !Number.isSafeInteger(n) || n < 1; })) throw new Error('근거 페이지는 1 이상의 정수여야 해요.');
            }
            if (!cells[0]) throw new Error('빈 그룹을 채워 주세요. (' + (index + 1) + '번째 항목)');
            var target = {kind: kind, group: cells[0]};
            if (kind === 'supplier') {
                var name = cells[legacy ? 2 : 1];
                if (!name) throw new Error('회사명을 채워 주세요. (' + (index + 1) + '번째 항목)');
                target.category = legacy ? cells[1] : cells[0]; target.company_name = name;
                if (!legacy) {
                    var matches = originals.get(JSON.stringify(cells)), original = matches && matches.pop();
                    if (original) target = Object.assign({}, original.target);
                }
            } else if (kind === 'item') {
                target.hs_codes = cells[1] ? cells[1].split(/[,，\n]/).map(function (s) { return s.trim(); }) : [];
                target.specification = cells[2]; target.requirements = cells[3];
                if (!cells[1] && !cells[2] && !cells[3]) throw new Error('HS, 규격, 조건 중 하나는 입력하세요.');
            } else {
                if (!cells[1]) throw new Error('조건 내용을 채워 주세요.');
                target.description = cells[1];
            }
            return {target: target, source_pages: sourcePages};
        });
    }
    function requireExcel() { window.workspaceSheet.requireExcel('1.9'); }
    async function metadata(context, cid, did) {
        var setting = context.workbook.settings.getItemOrNullObject(key(cid, did));
        setting.load('value'); await context.sync();
        return setting.isNullObject ? null : setting.value;
    }
    async function isReady(cid, did, rows) {
        requireExcel();
        return Excel.run(async function (context) {
            var meta = await metadata(context, cid, did);
            if (!meta || !meta.entries.length) return false;
            return rows.every(function (row) { return meta.entries.some(function (entry) { return entry.kind === row.target.kind; }); });
        });
    }
    async function ensure(cid, did, filename, rows) {
        requireExcel();
        return Excel.run(async function (context) {
            var saved = await metadata(context, cid, did), meta = saved || {entries: [], baseline: rows, original_rows: rows};
            if (saved && canonical(meta.baseline) !== canonical(rows)) throw new Error('기존 검토 시트와 저장된 조건이 달라요. 시트의 수정 내용부터 확인하세요.');
            var kinds = Array.from(new Set(rows.map(function (row) { return row.target.kind; })));
            if (!kinds.length && !meta.entries.length) kinds.push('other');
            for (var kind of kinds) {
                if (meta.entries.some(function (entry) { return entry.kind === kind; })) continue;
                var name = (kind === 'supplier' ? '거래처검토_' : kind === 'item' ? '품목검토_' : '조건검토_') + window.apiClient.newRequestId().replace(/-/g, '').slice(0, 12);
                var sheet = context.workbook.worksheets.add(name);
                var data = rows.filter(function (row) { return row.target.kind === kind; }).map(values);
                if (!data.length) data = [headers[kind].map(function () { return ''; })];
                try {
                    sheet.getRange('A1').numberFormat = [['@']];
                    sheet.getRange('A1').values = [["'" + filename]];
                    sheet.getRange('A2').values = [['표 안에서 수정·추가·행 삭제 후 추가 기능의 수정 내용 반영을 누르세요.']];
                    var grid = [headers[kind]].concat(data), range = sheet.getRangeByIndexes(3, 0, grid.length, headers[kind].length);
                    range.numberFormat = grid.map(function (row) { return row.map(function () { return '@'; }); });
                    range.values = grid.map(function (row) { return row.map(function (value) { return value ? "'" + value : ''; }); });
                    var table = sheet.tables.add(range, true);
                    sheet.load('id,name'); table.load('id');
                    range.format.columnWidth = 120; range.format.wrapText = true;
                    sheet.getRange(kind === 'item' ? 'D:D' : 'B:B').format.columnWidth = 280;
                    sheet.freezePanes.freezeRows(4);
                    await context.sync();
                    meta.entries.push({kind: kind, worksheet_id: sheet.id, table_id: String(table.id)});
                    context.workbook.settings.add(key(cid, did), meta); await context.sync();
                } catch (error) {
                    throw new Error('검토 시트 작성이 완료되지 않았어요. ‘' + name + '’ 시트가 남아 있을 수 있어요. ' + error.message);
                }
            }
            if (meta.entries.length) {
                context.workbook.worksheets.getItem(meta.entries[0].worksheet_id).activate();
                await context.sync();
            }
            return meta;
        });
    }
    async function read(cid, did) {
        requireExcel();
        return Excel.run(async function (context) {
            var meta = await metadata(context, cid, did);
            if (!meta) return null;
            var rows = [];
            for (var entry of meta.entries) {
                var snapshot = await tableSnapshot(context, entry);
                rows = rows.concat(parse(entry.kind, snapshot.values, snapshot.legacy, meta.baseline));
            }
            return {rows: rows, baseline: meta.baseline};
        });
    }
    async function tableSnapshot(context, entry) {
        var table = context.workbook.worksheets.getItem(entry.worksheet_id).tables.getItem(entry.table_id);
        var header = table.getHeaderRowRange(), count = table.rows.getCount();
        header.load('values'); await context.sync();
        var legacy = entry.kind === 'supplier' && JSON.stringify(header.values[0]) === JSON.stringify(legacySupplierHeaders);
        if (!legacy && JSON.stringify(header.values[0]) !== JSON.stringify(headers[entry.kind])) throw new Error('검토 표의 열 이름과 순서를 원래대로 돌려 주세요.');
        var snapshot = {worksheet_id: entry.worksheet_id, table_id: entry.table_id, kind: entry.kind, legacy: legacy, headers: header.values[0], values: []};
        if (!count.value) return snapshot;
        var body = table.getDataBodyRange();
        body.load('rowIndex,columnIndex,rowCount,columnCount'); await context.sync();
        body.load('values,formulas'); await context.sync();
        if (body.formulas.some(function (row) { return row.some(function (v) { return typeof v === 'string' && v[0] === '='; }); })) throw new Error('검토 표에는 수식 대신 값을 입력하세요.');
        snapshot.row_start = body.rowIndex; snapshot.column_start = body.columnIndex; snapshot.values = body.values;
        return snapshot;
    }
    async function preprocessTargets(cid, did) {
        requireExcel();
        return Excel.run(async function (context) {
            var meta = await metadata(context, cid, did);
            if (!meta) throw new Error('먼저 검토 시트를 열어 주세요.');
            var targets = [];
            for (var entry of meta.entries) {
                var snapshot = await tableSnapshot(context, entry);
                targets = targets.concat(snapshot.headers.map(function (header, index) {
                    return {table_id: entry.table_id, column_index: index, kind: entry.kind,
                        label: (meta.entries.length > 1 ? {supplier: '거래처', item: '품목', other: '기타'}[entry.kind] + ' · ' : '') + header};
                }));
            }
            return targets;
        });
    }
    async function preprocessSnapshot(context, cid, did, target) {
        var meta = await metadata(context, cid, did);
        var entry = meta && meta.entries.find(function (item) { return item.table_id === target.table_id; });
        if (!entry || !Number.isInteger(target.column_index) || target.column_index < 0) throw new Error('이 PDF 검토 표의 열을 다시 선택하세요.');
        var snapshot = await tableSnapshot(context, entry);
        if (target.column_index >= snapshot.headers.length) throw new Error('이 PDF 검토 표의 열을 다시 선택하세요.');
        if (!snapshot.values.length) throw new Error('검토 표에 처리할 행이 없어요.');
        snapshot.column_index = target.column_index;
        return snapshot;
    }
    async function readPreprocess(cid, did, target) {
        requireExcel();
        return Excel.run(function (context) { return preprocessSnapshot(context, cid, did, target); });
    }
    async function writePreprocess(cid, did, snapshot, values) {
        requireExcel();
        if (!Array.isArray(values) || values.length !== snapshot.values.length || values.some(function (v) { return typeof v !== 'string' || v.length > 32767; })) throw new Error('전처리 결과의 행 수나 값이 올바르지 않아요.');
        return Excel.run(async function (context) {
            var current = await preprocessSnapshot(context, cid, did, snapshot);
            if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('미리보기 이후 검토 표가 바뀌었어요. 변경 내용을 다시 확인해 주세요.');
            var column = context.workbook.worksheets.getItem(snapshot.worksheet_id).getRangeByIndexes(
                snapshot.row_start, snapshot.column_start + snapshot.column_index, values.length, 1);
            try {
                column.numberFormat = values.map(function () { return ['@']; });
                column.values = values.map(function (value) { return [value ? "'" + value : '']; });
                await context.sync();
            } catch (error) {
                throw new Error('검토 시트 적용을 완료했는지 확인하지 못했어요. 셀을 확인하고 새 미리보기로 진행해 주세요. ' + error.message);
            }
        });
    }
    async function sheetContext(cid, did) {
        requireExcel();
        return Excel.run(async function (context) {
            var meta = await metadata(context, cid, did);
            if (!meta) return [];
            var entries = meta.entries.map(function (entry) {
                var sheet = context.workbook.worksheets.getItemOrNullObject(entry.worksheet_id);
                sheet.load('name'); return {kind: entry.kind, sheet: sheet};
            });
            await context.sync();
            return entries.filter(function (entry) { return !entry.sheet.isNullObject; }).map(function (entry) {
                return {document_id: did, kind: entry.kind, sheet_name: entry.sheet.name};
            });
        });
    }
    async function markSaved(cid, did, rows) {
        requireExcel();
        await Excel.run(async function (context) {
            var meta = await metadata(context, cid, did);
            if (!meta) throw new Error('검토 시트 정보를 찾을 수 없어요.');
            if (!meta.original_rows) meta.original_rows = meta.baseline;
            meta.baseline = rows;
            context.workbook.settings.add(key(cid, did), meta); await context.sync();
        });
    }
    window.investigationSheet = {context: sheetContext, ensure: ensure, isReady: isReady, read: read, markSaved: markSaved, canonical: canonical, parse: parse, values: values,
        preprocessTargets: preprocessTargets, readPreprocess: readPreprocess, writePreprocess: writePreprocess};
})();
