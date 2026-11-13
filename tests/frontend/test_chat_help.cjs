const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

async function setup(saved) {
    const h = createDOM();
    const context = {workspace_id: 'work', worksheet_id: 'sheet', table_id: 'table', sheet_name: '작업표',
        task_type: 'model_normalization', row_count: 90000,
        columns: [{column_id: 'trade', role: 'trade_name'}, {column_id: 'model', role: 'model_spec'}], target_column_ids: ['model']};
    h.context = context; h.requests = []; h.actions = []; h.dismissed = 0;
    h.workspace = {context: async () => h.context, reset() {}, dismiss() { h.dismissed++; },
        open: async () => {}, configure: async settings => { h.configured = settings; },
        configureSimilarity: async settings => { h.similarity = settings; },
        recommendExtraction: async () => {},
        readRecommendation: async (ids, expected, progress, check) => { check(); h.readIds = ids; return {rows: [], column_ids: ids}; }};
    let nextId = 0;
    h.api = {newRequestId: () => 'request-' + ++nextId, requestJson: async (url, options = {}) => {
        h.requests.push({url, options, body: options.body && JSON.parse(options.body)});
        if (url === '/conversations') return {conversation_id: 'conversation'};
        if (url.endsWith('/cancel')) return {};
        if (url.endsWith('/recommendation-progress')) return h.progress(options);
        if (url === '/conversations/old') { const error = new Error('gone'); error.status = 404; throw error; }
        if (url.startsWith('/conversations/')) return {messages: []};
        return h.reply(url, options);
    }};
    h.reply = async () => ({answer: '완료', ui_action: null});
    h.progress = async () => ({message: 'AI 분석을 준비하고 있습니다…'});
    if (saved) h.localStorage.setItem('kcs-chat-session-v1', JSON.stringify(saved));
    h.load('chat/chat.js'); h.load('cleaning_help/cleaning_help.js');
    const close = () => { if (h.help) h.help.dismiss(); h.workspace.dismiss(); };
    h.chat = h.window.createChatController({api: h.api, getWorkspace: () => h.workspace,
        closeTaskCards: close, resetTasks: () => h.workspace.reset(),
        handleUIAction: async action => { h.actions.push(action); if (action?.type === 'open_cleaning_help') await h.help.open(action.column_ids); },
        onBusy: () => { if (h.help) h.help.updateControls(); }});
    h.help = h.window.createCleaningHelp({workspace: h.workspace, isBusy: h.chat.isBusy, setBusy: h.chat.setBusy,
        closeTaskCards: close, enterConversation: h.chat.enterConversation, sendMessage: h.chat.sendMessage});
    await h.chat.initialize();
    h.node = id => h.document.getElementById(id);
    return h;
}

test('chat response opens help; switching modes uses current target and restores the work panel', async () => {
    const h = await setup(); const panel = h.node('work-panel'), home = panel.parentNode, next = panel.nextSibling;
    h.reply = async () => ({answer: '도움 방식을 선택하세요.', ui_action: {type: 'open_cleaning_help', column_ids: ['trade']}});
    h.node('message').value = '다른 방식 있어?'; await h.chat.sendMessage();
    assert.equal(h.node('cleaning-help').hidden, false); assert.equal(h.chat.isBusy(), false);
    h.node('cleaning-help-kind').value = 'similarity'; await h.node('cleaning-help-kind').emit('change');
    assert.equal(h.similarity.column_id, 'trade'); assert.equal(panel.parentNode, h.node('cleaning-help-work'));
    h.node('cleaning-help-kind').value = 'extract'; await h.node('cleaning-help-kind').emit('change');
    assert.deepEqual(Array.from(h.configured.column_ids), ['model']);
    h.help.dismiss(); assert.equal(panel.parentNode, home); assert.equal(panel.nextSibling, next);
    assert.equal(h.node('cleaning-help').hidden, true);
});

test('AI advice reads requested data, restores draft, and never sends after workspace changed', async () => {
    const h = await setup(); await h.help.open();
    h.node('cleaning-help-kind').value = 'advice'; await h.node('cleaning-help-kind').emit('change');
    h.node('message').value = '남겨둔 입력';
    h.reply = async url => url === '/chat' ? {ui_action: {type: 'analyze_data', column_ids: ['trade', 'model']}}
        : {answer: '추천 결과', ui_action: null};
    await h.node('cleaning-help-advice').emit('click');
    assert.deepEqual(Array.from(h.readIds), ['trade', 'model']);
    assert.equal(h.node('message').value, '남겨둔 입력');
    assert(h.node('conversation').textContent.includes('추천 결과'));
    assert.equal(h.requests.filter(x => x.url === '/chat/recommendation').length, 1);
    await h.help.open(); h.node('cleaning-help-kind').value = 'advice';
    h.context = {...h.context, workspace_id: 'other'};
    await h.node('cleaning-help-advice').emit('click');
    assert(h.node('notice').textContent.includes('작업 표가 바뀌었습니다'));
    assert.equal(h.requests.filter(x => x.url === '/chat').length, 1);
});

test('stop aborts local request, calls server cancellation, and ignores a late reply', async () => {
    const h = await setup(); let resolveReply, requestStarted;
    const started = new Promise(resolve => { requestStarted = resolve; });
    h.reply = (url, options) => new Promise(resolve => { resolveReply = resolve; h.signal = options.signal; requestStarted(); });
    h.node('message').value = '긴 요청'; const running = h.chat.sendMessage(); await started;
    assert.equal(h.document.querySelector('.send').getAttribute('aria-label'), '요청 중지');
    await h.node('composer').emit('submit'); assert.equal(h.signal.aborted, true);
    resolveReply({answer: '늦은 결과', ui_action: {type: 'open_cleaning_help'}}); await running;
    assert(h.requests.some(x => x.url === '/conversations/conversation/requests/request-1/cancel'));
    assert.equal(h.actions.length, 0); assert(!h.node('conversation').textContent.includes('늦은 결과'));
    assert(h.node('conversation').textContent.includes('요청을 중지했습니다'));
    assert.equal(h.node('message').value, '긴 요청'); assert.equal(h.chat.isBusy(), false);
    assert.equal(JSON.parse(h.localStorage.getItem('kcs-chat-session-v1')).pending_request, null);
});

test('advice updates the existing notice through analysis and verification, then stops polling', async () => {
    const h = await setup(), timers = new Map(); let nextTimer = 0, finish;
    h.window.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
    h.window.clearTimeout = id => timers.delete(id);
    let stage = '1/2 · 상위 100개 분석 중', progressSignal;
    h.progress = async options => { progressSignal = options.signal; return {message: stage}; };
    h.reply = async url => url === '/chat'
        ? {ui_action: {type: 'analyze_data', column_ids: ['model']}}
        : new Promise(resolve => { finish = resolve; });
    const running = h.chat.sendMessage({workspace_id: 'work'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.node('notice').textContent, stage);
    assert.equal(timers.size, 1);
    stage = '2/2 · 제안 8개 전체 검증 중';
    const [id, tick] = timers.entries().next().value; timers.delete(id); await tick();
    assert.equal(h.node('notice').textContent, stage);
    finish({answer: '검증된 최종 의견', ui_action: null}); await running;
    assert.equal(h.node('notice').textContent, '');
    assert(h.node('conversation').textContent.includes('검증된 최종 의견'));
    assert.equal(timers.size, 0);
    assert.equal(progressSignal.aborted, true);
});

test('late progress cannot overwrite completed, failed, or cancelled advice', async () => {
    for (const outcome of ['complete', 'fail', 'cancel']) {
        const h = await setup(); let finish, fail, progressReply, progressSignal, timers = 0;
        h.window.setTimeout = () => { timers++; return 1; };
        h.progress = options => { progressSignal = options.signal; return new Promise(resolve => { progressReply = resolve; }); };
        h.reply = async url => url === '/chat'
            ? {ui_action: {type: 'analyze_data', column_ids: ['model']}}
            : new Promise((resolve, reject) => { finish = resolve; fail = reject; });
        const running = h.chat.sendMessage({workspace_id: 'work'});
        await new Promise(resolve => setImmediate(resolve));
        if (outcome === 'cancel') await h.node('composer').emit('submit');
        if (outcome === 'fail') fail(new Error('분석 실패'));
        else finish({answer: '결과', ui_action: null});
        await running;
        const notice = h.node('notice').textContent, count = timers;
        progressReply({message: '늦은 검증 안내'});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.node('notice').textContent, notice);
        assert.equal(timers, count);
        assert.equal(progressSignal.aborted, true);
        assert.equal(h.chat.isBusy(), false);
    }
});

test('progress lookup failure does not discard a successful analysis', async () => {
    const h = await setup();
    h.progress = async () => { throw new Error('진행 조회 연결 오류'); };
    h.reply = async url => url === '/chat'
        ? {ui_action: {type: 'analyze_data', column_ids: ['model']}}
        : {answer: '정상 의견', ui_action: null};
    await h.chat.sendMessage({workspace_id: 'work'});
    assert(h.node('conversation').textContent.includes('정상 의견'));
    assert.equal(h.node('notice').textContent, '');
});

test('retry keeps request ID; new question changes it; stale saved conversation recovers', async () => {
    const h = await setup({conversation_id: 'old'});
    assert.equal(h.chat.getConversationId(), 'conversation');
    h.reply = async () => { throw new Error('network'); };
    h.node('message').value = '첫 요청'; await h.chat.sendMessage(); await h.chat.sendMessage();
    h.node('message').value = '다른 요청'; await h.chat.sendMessage();
    const requests = h.requests.filter(x => x.url === '/chat');
    assert.equal(requests[0].body.request_id, requests[1].body.request_id);
    assert.notEqual(requests[1].body.request_id, requests[2].body.request_id);
});

test('page bootstrap wires chat and formula callbacks before initialization', async () => {
    const h = createDOM(); let workspaceOptions, formulaOptions;
    const stub = {dismiss() {}, reset() {}, setBusy() {}, context: async () => null, referenceTarget: () => null,
        formulaTarget() {}, validateFormulaSource() {}, prepareFormulaOutput() {}, formulaResultColumns() {}, formulaResult() {}};
    h.window.apiClient = {requestJson: async url => url.endsWith('/documents') ? {documents: []} : {conversation_id: 'conversation'}, newRequestId: () => 'id'};
    h.window.createWorkspaceController = options => { workspaceOptions = options; return stub; };
    h.window.createFormulaController = options => { formulaOptions = options; return stub; };
    h.window.createFormulaUI = () => ({});
    h.load('chat/chat.js'); h.load('cleaning_help/cleaning_help.js'); h.load('documents/documents.js'); h.load('taskpane.js');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workspaceOptions.isBusy(), false); assert.equal(workspaceOptions.getConversationId(), 'conversation');
    assert.equal(formulaOptions.validateSource, stub.validateFormulaSource);
    assert.equal(formulaOptions.getResultColumns, stub.formulaResultColumns);
    assert.equal(h.document.querySelector('.send').disabled, false);
});

test('all application scripts load in HTML order and the real controllers initialize', async () => {
    const h = createDOM(); const requests = [];
    h.window.location = {pathname: '/static/excel/taskpane-current.html'};
    h.window.crypto = require('node:crypto').webcrypto;
    h.sandbox.fetch = async (url, options) => {
        requests.push({url, options});
        return {ok: true, json: async () => url === '/conversations' ? {conversation_id: 'conversation'}
            : url.endsWith('/documents') ? {documents: []} : {answer: '도움 카드를 열었어.', ui_action: {type: 'open_cleaning_help'}}};
    };
    const scripts = h.document.querySelectorAll('script').map(node => node.getAttribute('src')).filter(Boolean);
    scripts.filter(file => !file.startsWith('vendor/')).forEach(file => h.load(file));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(r => r.url), ['/conversations', '/conversations/conversation/documents']);
    assert.equal(h.document.querySelector('.send').disabled, false);
    assert.equal(h.document.getElementById('notice').textContent, '');
    await h.document.getElementById('open-workspace').emit('click');
    assert.equal(h.document.getElementById('work-panel').hidden, false);
    h.document.getElementById('message').value = '정제 도움';
    await h.document.getElementById('composer').emit('submit');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.document.getElementById('cleaning-help').hidden, false);
    assert.equal(h.document.getElementById('work-panel').hidden, true);
    assert.equal(h.document.getElementById('cleaning-help-setup').hidden, false);
    assert.equal(h.document.querySelector('.send').disabled, false);
});

test('chat displays server validation text without another failure message and clears stale retry', async () => {
    const h = await setup();
    const message = '대상 열을 다시 확인하세요.';
    h.reply = async () => { throw Object.assign(new Error(message), {status: 422}); };
    h.node('message').value = '정제해줘'; await h.chat.sendMessage();
    const last = h.node('conversation').children.at(-1);
    assert.equal(last.children[1].textContent, message);
    assert.equal(JSON.parse(h.localStorage.getItem('kcs-chat-session-v1')).pending_request, null);
    assert.equal(h.chat.isBusy(), false);
});
