// node --test tests/*.test.cjs (추가 패키지 없이 실행)
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..', 'src/static/excel');

function load(file, extras = {}) {
    const scope = { window: { crypto: webcrypto }, ...extras };
    vm.runInNewContext(readFileSync(path.join(root, file), 'utf8'), scope);
    return scope.window;
}

test('HTTP 오류 상세·상태와 네트워크 오류를 보존한다', async () => {
    let response;
    const api = load('api_client.js', { fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
    } }).apiClient;
    response = { ok: true, json: async () => ({ answer: 'ok' }) };
    assert.deepEqual(await api.requestJson('/chat'), { answer: 'ok' });
    response = { ok: false, status: 404, json: async () => ({ detail: '대화 없음' }) };
    await assert.rejects(() => api.requestJson('/chat'), e => e.status === 404 && e.message === '대화 없음');
    response = { ok: false, status: 422, json: async () => ({ detail: [{ loc: ['body', 'rules'], msg: 'invalid' }] }) };
    await assert.rejects(() => api.requestJson('/chat'), e => e.status === 422 && e.message.includes('body.rules: invalid'));
    response = { ok: false, status: 502, json: async () => { throw new Error('html'); } };
    await assert.rejects(() => api.requestJson('/chat'), /HTTP 502/);
    response = new Error('offline');
    await assert.rejects(() => api.requestJson('/chat'), /offline/);
    const ids = Array.from({ length: 10 }, () => api.newRequestId());
    assert.equal(new Set(ids).size, 10);
    ids.forEach(id => assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/));
});

function controllerSetup() {
    let handlers, busy = false, ids = 0, fail = true;
    const calls = [], displays = [];
    const selection = { headers: ['a', 'b', 'c'], rows: [{ cells: ['a', 'b', 'c'] }] };
    const ui = {
        bind(value) { handlers = value; },
        open() {}, archive() {}, beginSelection() {}, clearResult() {},
        showSelection(value) { displays.push(value); },
        renderJob(value) { displays.push(value); },
        reset() { displays.push('reset'); }, showExportPreview() {},
        setStatus(value) { displays.push(value); },
        getMapping() { return [0, 1, 2]; },
        setBusy(value, hasPayload) { displays.push({ busy: value, hasPayload }); },
    };
    const api = {
        newRequestId() { return 'job-' + ++ids; },
        async requestJson(url, options) {
            calls.push({ url, options });
            if (url.endsWith('/analyze') && fail) {
                fail = false;
                throw new Error('응답 유실');
            }
            if (url.endsWith('/preview')) return {preview_id: 'preview-1', rows: [], row_count: 1, changed_count: 0};
            return { job_id: 'job-' + ids, status: url.endsWith('/analyze') ? 'REVIEW_READY' : 'CREATED', analysis: '결과' };
        },
    };
    const options = {
        ui, api, excel: { async readNormalizationRows() { return selection; } },
        isReady: () => true, isBusy: () => busy,
        setBusy(value) { busy = value; controller.setBusy(value); },
        getConversationId: () => 'conversation-1',
    };
    const controller = load('normalization.js').createNormalizationController(options);
    return { controller, handlers, calls, displays, options, ui, isBusy: () => busy };
}

test('분석 재시도는 같은 Job·입력 사용, 열 변경·새 대화는 이전 요청 해제', async () => {
    const s = controllerSetup();
    await s.handlers.select();
    await s.handlers.analyze();
    assert.equal(s.isBusy(), false);
    assert.ok(s.displays.some(x => typeof x === 'string' && x.includes('응답 유실')));
    await s.handlers.analyze();
    const creates = s.calls.filter(x => x.url === '/jobs');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].options.body, creates[1].options.body);
    assert.equal(JSON.parse(creates[0].options.body).conversation_id, 'conversation-1');
    s.handlers.mappingChange();
    await s.handlers.analyze();
    assert.equal(JSON.parse(s.calls.filter(x => x.url === '/jobs').at(-1).options.body).job_id, 'job-2');
    s.controller.reset();
    const count = s.calls.length;
    await s.handlers.analyze();
    await s.handlers.refresh();
    assert.equal(s.calls.length, count);
});

test('잘못된 매핑과 작업 중 중복 동작 차단', async () => {
    const s = controllerSetup();
    await s.handlers.select();
    s.ui.getMapping = () => [0, 0, 2];
    await s.handlers.analyze();
    assert.equal(s.calls.length, 0);
    assert.ok(s.displays.some(x => typeof x === 'string' && x.includes('서로 다른 열')));
    s.options.isBusy = () => true;
    await s.handlers.select();
    await s.handlers.analyze();
    assert.equal(s.calls.length, 0);
});

test('UI·컨트롤러는 요청 구현과 전역 채팅 상태를 소유하지 않는다', () => {
    const ui = readFileSync(path.join(root, 'normalization_ui.js'), 'utf8');
    assert.doesNotMatch(ui, /fetch\(|Excel\.run|requestJson\(/);
    const controller = readFileSync(path.join(root, 'normalization.js'), 'utf8');
    assert.doesNotMatch(controller, /document\.|workflowBusy|\bsending\b/);
    const html = readFileSync(path.join(root, 'taskpane.html'), 'utf8');
    const ordered = ['api_client.js', 'excel_bridge.js', 'normalization_ui.js', 'normalization.js', 'taskpane.js'];
    ordered.forEach((name, index) => {
        assert.ok(html.includes('src="' + name + '"'));
        if (index) assert.ok(html.indexOf('src="' + ordered[index - 1] + '"') < html.indexOf('src="' + name + '"'));
    });
});

test('거래처 컨트롤러는 후보 검토·승인 미리보기 뒤 같은 작업을 새 시트에 쓴다', async () => {
    let handlers, busy = false, calls = [];
    const selection = {
        headers: ['OVCS_SGN', 'OVCS_NAT_CD', 'OVCS_CONM'], row_count: 3,
        rows: [{ cells: ['1', 'VN', 'A'] }, { cells: ['2', 'VN', 'A'] }]
    };
    const ui = {
        bind(value) { handlers = value; }, open() {}, beginSelection() {},
        showSelection() {}, setStatus() {}, setBusy() {}, reset() {},
        clearApprovalPreview() {}, showApprovalPreview() {}, setExported() {},
        getMapping() { return [0, 1, 2]; }, renderJob() {},
        getDecisions() { return [{group_id: 'VN-1', decision: 'APPROVE', representative_party_code: '1'}]; }
    };
    const api = {
        newRequestId() { return 'job-1'; },
        async requestJson(url, options) {
            calls.push({ url, options });
            if (url.endsWith('/preview')) return {
                preview_id: 'preview-1', row_count: 2, rows: [{excel_row: 2}]
            };
            if (url.includes('/previews/')) return {
                preview_id: 'preview-1', row_count: 2, rows: [{excel_row: 2}]
            };
            const reviewed = url.includes('/analyze');
            return {status: reviewed ? 'REVIEW_READY' : 'CANDIDATES_READY',
                candidate_groups: [{group_id: 'VN-1'}],
                final_candidates: reviewed ? [{group_id: 'VN-1'}] : [], excluded_candidate_count: 0};
        }
    };
    let written = null;
    load('counterparty.js').createCounterpartyController({
        ui, api, excel: {
            async readCounterpartyRows() { return selection; },
            async writeCounterpartyPreview(value) { written = value; return {sheet_name: '거래처_1', row_count: 2}; }
        },
        isReady: () => true, isBusy: () => busy,
        setBusy(value) { busy = value; }, getConversationId: () => 'conversation-1'
    });
    await handlers.select();
    await handlers.create();
    await handlers.review();
    await handlers.preview();
    await handlers.export();
    assert.equal(calls[0].url, '/jobs');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.job_id, 'job-1');
    assert.equal(payload.rows.length, 2);
    assert.match(calls[1].url, /\/jobs\/job-1\/analyze/);
    assert.equal(calls[2].url, '/jobs/job-1/preview');
    assert.match(calls[3].url, /\/previews\/preview-1\/approve/);
    assert.equal(written.preview_id, 'preview-1');
});

test('거래처 화면·컨트롤러도 Excel과 HTTP 구현을 직접 소유하지 않는다', () => {
    const ui = readFileSync(path.join(root, 'counterparty_ui.js'), 'utf8');
    const controller = readFileSync(path.join(root, 'counterparty.js'), 'utf8');
    assert.doesNotMatch(ui, /fetch\(|Excel\.run|requestJson\(/);
    assert.doesNotMatch(controller, /document\.|Excel\.run|\bfetch\(/);
    const html = readFileSync(path.join(root, 'taskpane.html'), 'utf8');
    assert.ok(html.indexOf('src="counterparty_ui.js"') < html.indexOf('src="counterparty.js"'));
    assert.ok(html.indexOf('src="counterparty.js"') < html.indexOf('src="taskpane.js"'));
});
