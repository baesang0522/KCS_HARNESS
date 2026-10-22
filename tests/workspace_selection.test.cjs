const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '../src/static/excel');
const plain = value => JSON.parse(JSON.stringify(value));

function host(cells, selection, {supported = true} = {}) {
    const sheets = new Map(), settings = new Map(), copies = [], reads = [];
    function makeSheet(id, values = []) {
        const grid = new Map();
        values.forEach((row, r) => row.forEach((value, c) => {
            if (value !== '') grid.set(`${r},${c}`, value);
        }));
        const sheet = {id, name: id, grid, load() {}, activate() { sheet.active = true; }};
        function range(row, column, rows, columns) {
            const result = {
                worksheet: sheet, rowIndex: row, columnIndex: column,
                rowCount: rows, columnCount: columns,
                address: `${id}!R${row + 1}C${column + 1}:R${row + rows}C${column + columns}`,
                format: {}, load(fields) { reads.push({id, row, column, rows, columns, fields}); },
                select() { sheet.selected = result; },
                get text() {
                    return Array.from({length: rows}, (_, r) => Array.from({length: columns}, (_, c) =>
                        String(grid.get(`${row + r},${column + c}`) ?? '')));
                },
                set values(values) {
                    values.forEach((line, r) => line.forEach((value, c) => grid.set(`${row + r},${column + c}`, value)));
                },
                getUsedRangeOrNullObject() {
                    const occupied = [...grid].filter(([key, value]) => {
                        const [r, c] = key.split(',').map(Number);
                        return value !== '' && r >= row && r < row + rows && c >= column && c < column + columns;
                    }).map(([key]) => key.split(',').map(Number));
                    if (!occupied.length) return {isNullObject: true, load() {}};
                    const r = Math.min(...occupied.map(cell => cell[0]));
                    const c = Math.min(...occupied.map(cell => cell[1]));
                    return range(r, c, Math.max(...occupied.map(cell => cell[0])) - r + 1,
                        Math.max(...occupied.map(cell => cell[1])) - c + 1);
                },
                copyFrom(input, kind) {
                    copies.push({input, output: result, kind});
                    if (kind === 'Values') result.values = input.text;
                }
            };
            return result;
        }
        sheet.getRangeByIndexes = range;
        sheet.getRange = () => ({});
        sheet.tables = {
            getItem() { return sheet.table; },
            add(area) {
                sheet.table = {
                    id: `table-${id}`, load() {},
                    columns: {load() {}, items: Array.from({length: area.columnCount}, (_, index) => ({
                        id: index + 10, index, name: String(grid.get(`${area.rowIndex},${area.columnIndex + index}`)).replace(/^'/, '')
                    }))},
                    getDataBodyRange: () => range(area.rowIndex + 1, area.columnIndex, area.rowCount - 1, area.columnCount)
                };
                return sheet.table;
            }
        };
        sheets.set(id, sheet);
        return sheet;
    }
    const sheet = makeSheet('source', cells);
    const selected = {worksheet: sheet, areas: {
        items: selection.map(args => sheet.getRangeByIndexes(...args)), load() {}
    }};
    const context = {
        workbook: {
            getSelectedRanges: () => selected,
            getSelectedRange() { throw new Error('Single-range API must not be used'); },
            worksheets: {getItem: id => sheets.get(id), getItemOrNullObject: id => sheets.get(id) || {isNullObject: true, load() {}}, add: makeSheet},
            settings: {add: (key, value) => settings.set(key, value), getItemOrNullObject: key => ({
                isNullObject: !settings.has(key), value: settings.get(key), load() {}
            })}
        },
        async sync() {}
    };
    const sandbox = {window: {}, Excel: {run: callback => callback(context)}, Office: {context: {requirements: {
        isSetSupported(api, version) { assert.equal(api, 'ExcelApi'); assert.equal(version, '1.9'); return supported; }
    }}}};
    ['workspace_sheet.js', 'workspace_copy.js'].forEach(file => vm.runInNewContext(readFileSync(path.join(root, file), 'utf8'), sandbox));
    return {api: sandbox.window, sandbox, sheet, sheets, selected, copies, reads};
}

const cells = [
    ['', '신고품명', '제외 열', '', '거래품명', '', '', '모델규격', '', '참고'],
    ['', '펌프', '비밀', '', '', '', '', 'AB-1', '', '설명1'],
    ['', '', '비밀', '', '펌프류', '', '', 'AB-2', '', '설명2'],
    ['', '', '비밀', '', '', '', '', 'AB-3', '', ''],
];

function prepare(source) {
    return Object.assign(source, {roles: ['declared_name', 'trade_name', 'model_spec'],
        mapping: {declared_name: 0, trade_name: 1, model_spec: 2},
        reference_columns: [{source_index: 3, description: '사용자가 입력한 열 설명'}],
        task_type: 'model_normalization'});
}

test('떨어진 열을 원본 순서로 읽고 중복 선택·빈칸·다른 마지막 행을 보존한다', async () => {
    const h = host(cells, [[0, 7, 1048576, 1], [0, 1, 1048576, 1], [0, 4, 1048576, 1], [0, 1, 1048576, 1]]);
    const source = plain(await h.api.workspaceSheet.readSource());
    assert.deepEqual(source.column_indexes, [1, 4, 7]);
    assert.equal(source.data_row_count, 3);
    assert.deepEqual(source.headers, ['신고품명', '거래품명', '모델규격']);
    assert.deepEqual(source.sample_rows, [{cells: ['펌프', '', 'AB-1']}, {cells: ['', '펌프류', 'AB-2']}, {cells: ['', '', 'AB-3']}]);
    assert.ok(h.reads.filter(r => r.fields === 'text').every(r => r.rows <= 21 && [1, 4, 7].includes(r.column)));
});

test('연속 선택과 시트 전체 선택도 사용 영역으로 잘라 읽는다', async () => {
    for (const selection of [[[0, 0, 10, 11]], [[0, 0, 1048576, 16384]]]) {
        const h = host(cells, selection);
        const source = plain(await h.api.workspaceSheet.readSource());
        assert.deepEqual(source.column_indexes, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.equal(source.column_count, 9);
        assert.equal(source.row_count, 4);
        assert.deepEqual(source.sample_rows[1].cells, cells[2].slice(1));
    }
});

test('행 구간 불일치·빈 선택·머리글만·행/열 한도·API 미지원은 거부한다', async () => {
    await assert.rejects(host(cells, [[0, 1, 4, 1], [1, 4, 3, 1]]).api.workspaceSheet.readSource(), /같은 시작 행/);
    await assert.rejects(host([], [[0, 1, 4, 1]]).api.workspaceSheet.readSource(), /데이터가 없습니다/);
    await assert.rejects(host([['머리글']], [[0, 0, 1, 1]]).api.workspaceSheet.readSource(), /머리글과 데이터/);
    const tall = host([['머리글']], [[0, 0, 1048576, 1]]);
    tall.sheet.grid.set('400001,0', '끝');
    await assert.rejects(tall.api.workspaceSheet.readSource(), /400,000행/);
    await assert.rejects(host([Array(201).fill('열'), Array(201).fill('값')], [[0, 0, 2, 201]]).api.workspaceSheet.readSource(), /200열/);
    await assert.rejects(host(cells, [[0, 0, 4, 10]], {supported: false}).api.workspaceSheet.readSource(), /1.9/);
});

test('작업 시트는 선택 열만 복사하고 설명·역할·실제 위치·원본 행 번호를 저장한다', async () => {
    const h = host(cells, [[0, 1, 4, 1], [0, 4, 4, 1], [0, 7, 4, 1], [0, 9, 4, 1]]);
    const original = [...h.sheet.grid];
    const source = prepare(await h.api.workspaceSheet.readSource());
    const work = plain(await h.api.workspaceCopy.create(source, 'work'));
    assert.deepEqual(work.columns.map(c => c.source_column_index), [1, 4, 7, 9]);
    assert.deepEqual(work.columns.map(c => c.role), ['declared_name', 'trade_name', 'model_spec', 'reference']);
    assert.equal(work.columns[3].description, '사용자가 입력한 열 설명');
    assert.deepEqual(h.sheets.get('work').getRangeByIndexes(1, 0, 3, 5).text, [
        ['2', '펌프', '', 'AB-1', '설명1'], ['3', '', '펌프류', 'AB-2', '설명2'], ['4', '', '', 'AB-3', '']
    ]);
    assert.deepEqual(h.copies.filter(c => c.kind === 'Values').map(c => c.input.columnIndex), [1, 4, 7, 9]);
    assert.deepEqual([...h.sheet.grid], original);
});

test('연속 범위에서 카드로 떨어진 열을 고르는 기존 복사도 유지한다', async () => {
    const h = host(cells, [[0, 0, 4, 10]]);
    const source = prepare(await h.api.workspaceSheet.readSource());
    source.mapping = {declared_name: 0, trade_name: 3, model_spec: 6};
    source.reference_columns = [{source_index: 8, description: '추가 설명'}];
    const work = plain(await h.api.workspaceCopy.create(source, 'work'));
    assert.deepEqual(work.columns.map(c => c.source_column_index), [1, 4, 7, 9]);
    assert.equal(work.columns[3].description, '추가 설명');
});

test('복사 전 원본 머리글 변경과 잘못된 위치 배열을 거부한다', async () => {
    const h = host(cells, [[0, 1, 4, 1], [0, 4, 4, 1], [0, 7, 4, 1], [0, 9, 4, 1]]);
    const source = prepare(await h.api.workspaceSheet.readSource());
    h.sheet.grid.set('0,7', '변경된 모델');
    await assert.rejects(h.api.workspaceCopy.create(source, 'work'), /원본 열 구성이 바뀌었습니다/);
    assert.equal(h.sheets.has('work'), false);
    source.column_indexes = [1, 1, 7, 9];
    await assert.rejects(h.api.workspaceCopy.create(source, 'work'), /원본 열 위치/);
});

function workHost(selection) {
    const h = host([['행번호', '신고품명', '거래품명', '모델규격'], ['2', '펌프', '펌프류', 'AB'], ['3', '펌프', '펌프류', 'AC']], selection);
    const table = h.sheet.tables.add(h.sheet.getRangeByIndexes(0, 0, 3, 4));
    const work = {worksheet_id: 'source', table_id: table.id, source_row_column_id: 10,
        columns: table.columns.items.slice(1).map(c => ({column_id: c.id, role: 'reference', description: '설명' + c.id}))};
    return {h, work};
}

test('작업 대상 재선택은 떨어진 열·행 부분 선택과 설명을 보존하고 원본 행 번호를 제외한다', async () => {
    const {h, work} = workHost([[2, 3, 1, 1], [2, 0, 1, 2], [2, 3, 1, 1]]);
    const target = plain(await h.api.workspaceSheet.readWorkspaceTarget(work, false));
    assert.deepEqual(target.columns.map(c => c.column_id), [11, 13]);
    assert.deepEqual(target.columns.map(c => c.description), ['설명11', '설명13']);
    assert.equal(target.row_start, 2); assert.equal(target.row_count, 1);
    assert.equal(target.column_count, 2);
});

test('작업 대상 연속 선택·전체 열 선택·저장 작업 복귀를 유지한다', async () => {
    for (const selection of [[[0, 0, 3, 4]], [[0, 0, 1048576, 4]]]) {
        const {h, work} = workHost(selection);
        const target = plain(await h.api.workspaceSheet.readWorkspaceTarget(work, false));
        assert.deepEqual(target.columns.map(c => c.column_id), [11, 12, 13]);
        assert.equal(target.row_start, 1); assert.equal(target.row_count, 2);
        h.selected.worksheet = {id: 'other', load() {}};
        assert.equal(await h.api.workspaceSheet.readWorkspaceTarget(work, false), null);
        const restored = plain(await h.api.workspaceSheet.readWorkspaceTarget(work, true));
        assert.deepEqual(restored.columns, target.columns);
        assert.equal(h.sheet.active, true);
    }
});

test('작업 표 밖 영역은 제외하고 행 구간 불일치·행 번호만 선택은 거부한다', async () => {
    let setup = workHost([[1, 1, 2, 1], [1, 7, 2, 1]]);
    assert.equal((await setup.h.api.workspaceSheet.readWorkspaceTarget(setup.work, false)).column_count, 1);
    for (const [selection, error] of [
        [[[1, 1, 2, 1], [2, 3, 1, 1]], /같은 시작 행/],
        [[[1, 0, 2, 1]], /원본 행 번호/],
        [[[1, 7, 2, 1]], /데이터가 있는 열/]
    ]) {
        const {h, work} = workHost(selection);
        await assert.rejects(h.api.workspaceSheet.readWorkspaceTarget(work, false), error);
    }
});

test('머리글이 아래쪽에 있어도 원본 행 위치와 20행 표본 제한을 지킨다', async () => {
    const data = [[], [], [], ['이름', '', '모델'], ...Array.from({length: 30}, (_, i) => ['이름' + i, '', '모델' + i])];
    const h = host(data, [[0, 0, 1048576, 1], [0, 2, 1048576, 1]]);
    const source = plain(await h.api.workspaceSheet.readSource());
    assert.equal(source.row_start, 3);
    assert.equal(source.data_row_count, 30);
    assert.equal(source.sample_rows.length, 20);
    assert.deepEqual(source.sample_rows[19].cells, ['이름19', '모델19']);
});

test('카드는 실제 Excel 열 문자를 표시하고 추가 열 설명과 위치를 전달한다', async () => {
    function element() {
        return {children: [], events: {}, value: '', appendChild(child) { this.children.push(child); },
            setAttribute() {}, addEventListener(name, handler) { this.events[name] = handler; }};
    }
    const h = host(cells, [[0, 1, 4, 1], [0, 4, 4, 1], [0, 7, 4, 1], [0, 9, 4, 1]]);
    h.sandbox.document = {createElement: element, createTextNode: text => ({textContent: text})};
    vm.runInNewContext(readFileSync(path.join(root, 'workspace_columns.js'), 'utf8'), h.sandbox);
    const selects = [element(), element(), element()], container = element();
    const ui = h.api.createWorkspaceColumns(selects, container, [
        {labels: ['신고품명']}, {labels: ['거래품명']}, {labels: ['모델규격']}
    ]);
    ui.showSelection(await h.api.workspaceSheet.readSource());
    assert.deepEqual(selects[0].children.slice(1).map(option => option.textContent),
        ['B열 · 신고품명', 'E열 · 거래품명', 'H열 · 모델규격', 'J열 · 참고']);
    const card = container.children[0];
    const checkbox = card.children[0].children[0], description = card.children[1].children[1];
    checkbox.checked = true; checkbox.events.change();
    description.value = ' 사용자 설명 '; description.events.input();
    assert.deepEqual(plain(ui.getExtraColumns()), [{source_index: 3, column_index: 9, header: '참고', description: '사용자 설명'}]);
});
