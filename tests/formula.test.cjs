const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '..', 'src', 'static', 'excel');

function bridgeSetup(occupied = false) {
    let writtenFormula = null;
    let filledRange = null;
    const target = {
        address: 'Sheet1!B2:B4', rowCount: 3, columnCount: 1,
        rowIndex: 1, columnIndex: 1,
        values: [[occupied ? '기존 값' : ''], [''], ['']],
        formulas: [[occupied ? '기존 값' : ''], [''], ['']],
        text: [['11'], ['12'], ['13']],
        load() {}, calculate() {}, clear() {},
    };
    function candidate(columnIndex) {
        const letter = String.fromCharCode(65 + columnIndex);
        return {
            address: `Sheet1!${letter}2:${letter}4`, rowCount: 3, columnCount: 1,
            rowIndex: 1, columnIndex,
            values: [[columnIndex === 1 && occupied ? '기존 값' : ''], [''], ['']],
            formulas: [[columnIndex === 1 && occupied ? '기존 값' : ''], [''], ['']],
            load() {},
        };
    }
    const anchor = {
        set formulas(value) { writtenFormula = value[0][0]; },
        autoFill(address, type) { filledRange = [address, type]; },
    };
    const sheet = {
        getRange(address) { return address === 'B2' ? anchor : target; },
        getRangeByIndexes(row, column) { return candidate(column); },
    };
    const sandbox = {
        window: {},
        Office: {context: {requirements: {isSetSupported: (api, version) =>
            api === 'ExcelApi' && version === '1.9'}}},
        Excel: {run: async callback => callback({
            workbook: {worksheets: {getItem() { return sheet; }}},
            async sync() {},
        })},
    };
    vm.runInNewContext(readFileSync(path.join(root, 'excel_bridge.js'), 'utf8'), sandbox);
    return {
        bridge: sandbox.window.excelBridge,
        result: () => ({writtenFormula, filledRange}),
    };
}

const preview = {
    plan: {actions: [{
        target_range: 'B2:B4', anchor_cell: 'B2', formula: '=A2+10',
        output_label: '결과',
        mode: 'fill_down', overwrite: 'reject_nonblank',
    }]},
};
const selection = {
    sheet_name: 'Sheet1', row_start: 1, column_start: 0,
    row_count: 3, column_count: 1,
};

test('빈 결과 열에 기준 수식을 쓰고 Excel 자동 채우기를 사용한다', async () => {
    const setup = bridgeSetup();
    const result = await setup.bridge.applyFormulaPreview(preview, selection);
    assert.equal(result.row_count, 3);
    assert.equal(setup.result().writtenFormula, '=A2+10');
    assert.deepEqual(setup.result().filledRange, ['B2:B4', 'FillCopy']);
});

test('제안된 결과 범위가 차 있으면 오른쪽 첫 빈 열을 사용한다', async () => {
    const setup = bridgeSetup(true);
    const target = await setup.bridge.prepareFormulaPreview(preview, selection);
    assert.equal(target.target_range, 'C2:C4');
    assert.equal(target.reason, 'automatic');
    assert.equal(setup.result().writtenFormula, null);
});

test('복수 수식은 계획된 결과 열에 함께 적용한다', async () => {
    const written = {};
    function target(address, columnIndex) {
        return {
            address: 'Sheet1!' + address, rowCount: 3, columnCount: 1,
            rowIndex: 1, columnIndex, values: [[''], [''], ['']],
            formulas: [[''], [''], ['']], text: [['1'], ['2'], ['3']],
            load() {}, calculate() {}, clear() {},
        };
    }
    const targets = { 'B2:B4': target('B2:B4', 1), 'C2:C4': target('C2:C4', 2) };
    const sheet = {getRange(address) {
        if (targets[address]) return targets[address];
        return {
            set formulas(value) { written[address] = value[0][0]; },
            autoFill() {},
        };
    }};
    const sandbox = {
        window: {},
        Office: {context: {requirements: {isSetSupported: () => true}}},
        Excel: {run: async callback => callback({
            workbook: {worksheets: {getItem() { return sheet; }}}, async sync() {},
        })},
    };
    vm.runInNewContext(readFileSync(path.join(root, 'excel_bridge.js'), 'utf8'), sandbox);
    const multi = {plan: {actions: [
        {target_range: 'B2:B4', anchor_cell: 'B2', formula: '=A2+1', mode: 'fill_down'},
        {target_range: 'C2:C4', anchor_cell: 'C2', formula: '=B2*2', mode: 'fill_down'},
    ]}};
    const result = await sandbox.window.excelBridge.applyFormulaPreview(multi, selection);
    assert.equal(written.B2, '=A2+1');
    assert.equal(written.C2, '=B2*2');
    assert.equal(result.action_count, 2);
});

test('수식 컨트롤러는 같은 계획을 승인한 뒤 Excel 적용 완료를 보고한다', async () => {
    let handlers, scheduled;
    let readAttempts = 0;
    let validations = 0;
    const calls = [];
    const ui = {
        bind(value) { handlers = value; }, open() {}, reset() {}, setStatus() {},
        setBusy() {}, showPreview() {}, setApplied() {},
    };
    const api = {
        newRequestId() { return 'job-1'; },
        async requestJson(url, options) {
            calls.push({url, options});
            if (url === '/jobs') return {job_id: 'job-1', status: 'CREATED'};
            if (url.endsWith('/analyze')) return {
                job_id: 'job-1', status: 'PREVIEW_READY',
                preview: {preview_id: 'preview-1', ...preview},
            };
            if (url.endsWith('/approve')) return {preview_id: 'preview-1', ...preview};
            return {status: 'APPLIED'};
        },
    };
    const excel = {
        async readFormulaContext() {
            readAttempts += 1;
            if (readAttempts === 1) throw new Error('원본 범위를 선택하세요.');
            return {task_type: 'formula', ...selection, address: 'Sheet1!A2:A4', samples: [{cells: ['1']}], worksheet_id: 'sheet-1'};
        },
        async prepareFormulaPreview() { return {
            address: 'Sheet1!B2:B4', target_range: 'B2:B4', anchor_cell: 'B2',
            row_count: 3, reason: 'planned'
        }; },
        async readFormulaTarget() { return {
            address: 'Sheet1!C2:C4', target_range: 'C2:C4', anchor_cell: 'C2',
            row_count: 3, reason: 'manual'
        }; },
        async validateFormulaPreview() { validations += 1; },
        async applyFormulaPreview() { return {address: 'Sheet1!B2:B4', row_count: 3}; },
    };
    const scope = {window: {setTimeout(callback) { scheduled = callback(); }}};
    vm.runInNewContext(readFileSync(path.join(root, 'formula.js'), 'utf8'), scope);
    const controller = scope.window.createFormulaController({
        ui, api, excel, isReady: () => true, isBusy: () => false,
        setBusy() {}, getConversationId: () => 'conversation-1',
    });
    controller.openAndSelect('A열에 10을 더해줘');
    await scheduled;
    assert.equal(calls.length, 0);
    await handlers.source();
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.instruction, 'A열에 10을 더해줘');
    assert.equal(payload.task_type, 'formula');
    await handlers.target();
    assert.equal(validations, 2);
    await handlers.apply();
    const approval = calls.find(call => call.url.endsWith('/approve'));
    assert.deepEqual(JSON.parse(approval.options.body).target_ranges, ['C2:C4']);
    assert.ok(calls.some(call => call.url.endsWith('/complete')));
});
