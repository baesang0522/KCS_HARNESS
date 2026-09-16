// 프로젝트 루트에서 node --test tests/excel_bridge.test.cjs
// 실제 Excel 대신 Office API 모형으로 표본 크기와 검증 경계를 확인한다.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = readFileSync(path.join(root, 'src/static/excel/excel_bridge.js'), 'utf8');

function setup(options = {}) {
    const calls = [];
    const cells = options.cells || [
        ['거래품명', '신고품명', '모델규격'],
        ['펌프', '원심펌프', '  AB-100   220V  '],
    ];
    const range = {
        address: 'Sheet1!B4:D5', rowIndex: 3, columnIndex: 1,
        rowCount: options.rowCount ?? cells.length,
        columnCount: options.columnCount ?? 3,
        load(fields) { calls.push(['range.load', fields]); },
        worksheet: { id: 'sheet-1', name: 'Sheet1', load() {} },
        getCell(row, column) {
            calls.push(['getCell', row, column]);
            return {
                getResizedRange(rows, columns) {
                    calls.push(['resize', rows, columns]);
                    return {
                        text: cells.slice(row, row + rows + 1),
                        load(fields) { assert.equal(fields, 'text'); },
                    };
                },
            };
        },
    };
    const sandbox = { window: {} };
    if (!options.noHost) {
        sandbox.Office = { context: { requirements: {
            isSetSupported(api, version) {
                assert.equal(api, 'ExcelApi');
                assert.equal(version, '1.1');
                return options.supported !== false;
            },
        } } };
        sandbox.Excel = {
            async run(callback) {
                if (options.failure) throw new Error('Excel read failed');
                return callback({
                    workbook: { getSelectedRange: () => range },
                    async sync() { calls.push(['sync']); },
                });
            },
        };
    }
    vm.runInNewContext(source, sandbox);
    return {
        read: sandbox.window.excelBridge.readNormalizationSample,
        readCounterpartyRows: sandbox.window.excelBridge.readCounterpartyRows,
        calls
    };
}

test('범위 위치·머리글·셀 문자열을 보존한다', async () => {
    const { read, calls } = setup();
    const result = JSON.parse(JSON.stringify(await read()));
    assert.deepEqual(result, {
        worksheet_id: 'sheet-1', sheet_name: 'Sheet1', address: 'Sheet1!B4:D5',
        row_start: 3, column_start: 1, row_count: 2,
        headers: ['거래품명', '신고품명', '모델규격'],
        samples: [{ cells: ['펌프', '원심펌프', '  AB-100   220V  '] }],
    });
    assert.deepEqual(calls.filter(call => call[0] === 'resize'), [['resize', 1, 2]]);
    assert.equal(calls.filter(call => call[0] === 'sync').length, 2);
    assert.ok(!calls.find(call => call[0] === 'range.load')[1].includes('text'));
});

test('40만 행도 머리글과 앞부분 20행만 읽는다', async () => {
    const cells = Array.from({ length: 21 }, () => ['품명', '신고품명', '00123']);
    const { read, calls } = setup({ rowCount: 400001, cells });
    const result = await read();
    assert.equal(result.row_count, 400001);
    assert.equal(result.samples.length, 20);
    assert.equal(result.samples[0].cells[2], '00123');
    assert.deepEqual(calls.filter(call => call[0] === 'resize'), [['resize', 20, 2]]);
});

test('거래처 데이터는 총행 제한 없이 1,000행씩 전부 읽는다', async () => {
    const cells = Array.from({ length: 2002 }, (_, index) =>
        index ? ['VN-' + index, 'VN', 'COMPANY ' + index] : ['OVCS_SGN', 'OVCS_NAT_CD', 'OVCS_CONM']);
    const { readCounterpartyRows, calls } = setup({ rowCount: cells.length, cells });
    const result = await readCounterpartyRows();
    assert.equal(result.rows.length, 2001);
    assert.equal(result.rows[2000].cells[2], 'COMPANY 2001');
    assert.deepEqual(calls.filter(call => call[0] === 'resize'),
        [['resize', 999, 2], ['resize', 999, 2], ['resize', 1, 2]]);
});

test('호스트·API·선택 크기·셀 길이 오류를 거절한다', async () => {
    for (const [options, message] of [
        [{ noHost: true }, /엑셀 안에서/],
        [{ supported: false }, /ExcelApi 1.1/],
        [{ columnCount: 2 }, /세 열/],
        [{ columnCount: 4 }, /세 열/],
        [{ rowCount: 1 }, /머리글과 데이터/],
        [{ rowCount: 400002 }, /머리글과 데이터/],
        [{ cells: [['a', 'b', 'c'], ['a', 'b', 'x'.repeat(1001)]] }, /1,000자/],
        [{ failure: true }, /Excel read failed/],
    ]) {
        await assert.rejects(setup(options).read, message);
    }
    await setup({ cells: [['a', 'b', 'c'], ['a', 'b', 'x'.repeat(1000)]] }).read();
});

test('호출 전에 브리지를 로드하고 기존 UI는 브리지만 호출한다', () => {
    const html = readFileSync(path.join(root, 'src/static/excel/taskpane.html'), 'utf8');
    const ui = readFileSync(path.join(root, 'src/static/excel/normalization.js'), 'utf8');
    assert.ok(html.indexOf('src="excel_bridge.js"') < html.indexOf('src="normalization.js"'));
    assert.match(ui, /await excel\.readNormalizationSample\(\)/);
    assert.doesNotMatch(ui, /Excel\.run/);
});
