const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

async function setup(saved) {
    const h = createDOM();
    const context = {workspace_id: 'work', worksheet_id: 'sheet', table_id: 'table', sheet_name: '작업표',
        task_type: 'model_normalization', row_count: 90000,
        columns: [{column_id: 'trade', role: 'trade_name'}, {column_id: 'model', role: 'model_spec'}], target_column_ids: ['model']};
    h.context = context; h.requests = []; h.actions = []; h.origins = []; h.dismissed = 0;
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
    h.load('chat/chat.js'); h.load('chat/agent.js');
    const close = () => { if (h.help) h.help.dismiss(); h.workspace.dismiss(); };
    h.chat = h.window.createChatController({api: h.api, getWorkspace: () => h.workspace,
        getReviewSheets: async () => h.reviewSheets || [],
        closeTaskCards: close, resetTasks: () => h.workspace.reset(),
        beforeSend:()=>h.beforeSend && h.beforeSend(),
        handleUIAction: async (action, instruction, origin) => { h.actions.push(action); h.origins.push(origin); },
        onBusy: () => { if (h.help) h.help.updateControls(); }});

    await h.chat.initialize();
    h.node = id => h.document.getElementById(id);
    return h;
}

test('chat dispatches actions without opening removed settings panels', async () => {
 const h=await setup();h.reply=async()=>({answer:'변경 내용을 계산할게.',ui_action:{type:'configure_operation',operation:{kind:'preprocess'}}});
 h.node('message').value='공백 정리';await h.chat.sendMessage();
 assert.equal(h.actions[0].type,'configure_operation');assert.equal(h.chat.isBusy(),false);
 assert.equal(h.node('cleaning-help'),null);assert.equal(h.node('operations'),null);
});

test('AI advice reads requested data, restores draft, and rejects changed workspace', async()=>{
 const h=await setup();h.node('message').value='남겨둔 입력';
 h.reply=async url=>url==='/chat'?{ui_action:{type:'analyze_data',column_ids:['trade','model']}}:{answer:'추천 결과',ui_action:null};
 await h.chat.sendMessage({workspace_id:'work'});
 assert.deepEqual(Array.from(h.readIds),['trade','model']);assert.equal(h.node('message').value,'남겨둔 입력');
 assert.match(h.node('conversation').textContent,/추천 결과/);h.context={...h.context,workspace_id:'other'};
 await h.chat.sendMessage({workspace_id:'work'});assert.match(h.node('conversation').textContent,/대상이 바뀌/);
 assert.equal(h.requests.filter(x=>x.url==='/chat').length,1);
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
    const h = createDOM(); let workspaceOptions, formulaOptions, imports=0, scopes=0, reviewRequest, scopeRequest;
    const stub = {cancelPending() {}, isProcessing:()=>false, open:async()=>{}, dismiss() {}, reset() { this.referenceTarget=()=>null; }, setBusy() {}, context: async () => null, referenceTarget: () => null,
        openSourceColumns:async()=>{imports++;}, openScope:async()=>{scopes++;},
        changeScope:async(request,expected)=>{scopeRequest={request,expected};return "범위 변경 완료";},
        openGroups:async(column,request)=>{reviewRequest={column,request};},
        configure:async()=>{throw Error("unscoped set action reached ordinary operation");},
        formulaTarget() {}, validateFormulaSource() {}, prepareFormulaOutput() {}, formulaResultColumns() {}, formulaResult() {}};
    h.window.apiClient = {requestJson: async url => url.startsWith('/write-recovery') ? [] : url.endsWith('/agent-runs') ? {run: null} : url.endsWith('/documents') ? {documents: []} : url.endsWith('/investigation') ? {revision:0,goal:'목표',conditions:[],document_notes:{},columns:[]} : {conversation_id: 'conversation'}, newRequestId: () => 'id'};
    h.window.createWorkspaceController = options => { workspaceOptions = options; return stub; };
    h.window.createFormulaController = options => { formulaOptions = options; return stub; };
    h.window.createFormulaUI = () => ({});
    h.load('chat/chat.js'); h.load('chat/agent.js'); h.load('documents/documents.js'); h.load('documents/investigation.js'); h.load('documents/review_preprocess.js'); h.load('operations/write_recovery.js'); h.load('taskpane.js');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(workspaceOptions.isBusy(), false); assert.equal(workspaceOptions.getConversationId(), 'conversation');
    assert.equal(formulaOptions.validateSource, stub.validateFormulaSource);
    assert.equal(formulaOptions.getResultColumns, stub.formulaResultColumns);
    assert.equal(h.document.querySelector('.send').disabled, false);
    const button=h.document.getElementById('open-workspace');
    assert.equal(button.textContent,'작업 준비');
    assert.equal(h.document.getElementById('open-scope'),null);
    stub.referenceTarget=()=>({workspace_id:'work',task_type:'investigation'});
    await workspaceOptions.onWorkspaceReady(stub.referenceTarget());
    for(const message of ['변경이 없어 작업을 마쳤습니다.','결과를 작성했습니다.']) {
        workspaceOptions.complete(message);
        assert.equal(button.textContent,'열 추가');assert.equal(button.hidden,false);
        await button.emit('click');
    }
    assert.equal(imports,2);
    workspaceOptions.setBusy(true);await button.emit('click');assert.equal(imports,2);
    workspaceOptions.setBusy(false);
    const scopeAction={type:'change_scope',workspace_id:'work',expected_filter:null,request:{mode:'exclude',condition:{column_id:'country',operator:'equals',value:'CN'}}};
    h.window.apiClient.requestJson=async url=>url==='/chat'?{answer:'범위 확인',ui_action:scopeAction}:{documents:[]};
    h.document.getElementById('message').value='중국 제외';await h.document.getElementById('composer').emit('submit');
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(scopeRequest)),{request:scopeAction.request,expected:{...scopeAction,origin_request_id:"id"}});
    assert.match(h.document.getElementById('conversation').textContent,/범위 변경 완료/);
    for(const action of [
        {type:'open_group_review',column_ids:['company'],request:{match_text:'JIANGSU',output_name:'분석대상',assigned_value:'분석대상'}},
        {type:'configure_operation',operation:{kind:'set',column_ids:['company'],assigned_value:'분석대상'}}
    ]){
        h.window.apiClient.requestJson=async url=>url==='/chat'?{answer:'검토',ui_action:action}:{documents:[]};
        h.document.getElementById('message').value='이 회사와 비슷한 행만 표시';
        await h.document.getElementById('composer').emit('submit');
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(reviewRequest,undefined);
        assert.match(h.document.getElementById('notice').textContent,/현재 사용하지|보류 중/);
    }
});

test('all application scripts load in HTML order and the real controllers initialize', async () => {
    const h = createDOM(); const requests = [];
    h.window.location = {pathname: '/static/excel/taskpane-current.html'};
    h.window.crypto = require('node:crypto').webcrypto;
    h.sandbox.fetch = async (url, options) => {
        requests.push({url, options});
        return {ok: true, json: async () => url === '/conversations' ? {conversation_id: 'conversation'}
            : url.startsWith('/write-recovery') ? [] : url.endsWith('/agent-runs') ? {run: null} : url.endsWith('/documents') ? {documents: []} : url.endsWith('/investigation') ? {revision:0,goal:'목표',conditions:[],document_notes:{},columns:[]} : {answer: '도움 카드를 열었어.', ui_action: {type: 'open_cleaning_help'}}};
    };
    const scripts = h.document.querySelectorAll('script').map(node => node.getAttribute('src')).filter(Boolean);
    assert.equal(scripts.some(file=>file.startsWith('group_review/')),false);
    assert.equal(h.document.getElementById('work-groups'),null);assert.equal(h.document.getElementById('gr-panel'),null);
    scripts.filter(file => !file.startsWith('vendor/')).forEach(file => h.load(file));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(r => r.url), ['/conversations', '/write-recovery?conversation_id=conversation', '/conversations/conversation/documents', '/conversations/conversation/investigation', '/conversations/conversation/agent-runs']);
    assert.equal(h.document.querySelector('.send').disabled, false);
    assert.equal(h.document.getElementById('notice').textContent, '');
    await h.document.getElementById('open-workspace').emit('click');
    assert.equal(h.document.getElementById('work-panel').hidden, false);
    h.document.getElementById('message').value = '정제 도움';
    await h.document.getElementById('composer').emit('submit');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.document.getElementById('cleaning-help'), null);
    assert.equal(h.document.getElementById('work-panel').hidden, true);
    assert.match(h.document.getElementById('conversation').textContent,/채팅으로/);
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


test('chat releases busy state before the action handler prepares a preview',async()=>{
 const h=await setup();h.reply=async()=>({answer:'변경 확인',ui_action:{type:'configure_operation',operation:{kind:'set'}}});
 let busy;h.actions.push=function(action){busy=h.chat.isBusy();return Array.prototype.push.call(this,action);};
 h.node('message').value='조건에 맞는 행 수정';await h.chat.sendMessage();assert.equal(busy,false);assert.equal(h.actions.length,1);
});

test('unreflected review edits block both new chat requests and a pending retry before sending',async()=>{
    const h=await setup();h.reply=async()=>{throw Error('network');};
    h.node('message').value='조건 설명';await h.chat.sendMessage();
    const calls=h.requests.filter(r=>r.url==='/chat').length;
    h.beforeSend=async()=>{throw Error('수정 내용 반영을 먼저 눌러 주세요.');};
    await h.chat.sendMessage();assert.equal(h.requests.filter(r=>r.url==='/chat').length,calls);
    h.node('message').value='새 질문';await h.chat.sendMessage();
    assert.equal(h.requests.filter(r=>r.url==='/chat').length,calls);
    assert.match(h.node('conversation').textContent,/수정 내용 반영/);assert.equal(h.chat.isBusy(),false);
});

test('chat advice uses server-selected subject without changing the workspace subject',async()=>{
 const h=await setup();h.context.task_type='investigation';h.context.advice_subject='company';let subject;
 h.workspace.readRecommendation=async(ids,expected)=>{subject=expected.advice_subject;return {rows:[],column_ids:ids};};
 h.reply=async url=>url==='/chat'?{ui_action:{type:'analyze_data',column_ids:['model'],advice_subject:'model'}}:{answer:'모델 의견',ui_action:null};
 h.node('message').value='모델 정제 의견';await h.chat.sendMessage();
 assert.equal(subject,'model');assert.equal(h.context.advice_subject,'company');
});

test('new investigation waits for conversation creation and preserves current UI if creation fails',async()=>{
 const h=await setup();h.node('conversation').textContent='기존 조사';
 const original=h.api.requestJson;h.api.requestJson=async url=>{if(url==='/conversations')throw Error('연결 실패');return original(url);};
 await assert.rejects(h.chat.newConversation(),/연결 실패/);
 assert.equal(h.node('conversation').textContent,'기존 조사');assert.equal(h.chat.getConversationId(),'conversation');
 h.api.requestJson=original;await h.chat.newConversation();assert.equal(h.node('conversation').textContent,'');
});


test('each chat action carries its own originating request after pending state is cleared', async () => {
    const h = await setup();
    h.reply = async () => ({answer: '미리보기', ui_action: {type: 'configure_operation'}});
    for (const message of ['첫 번째 정제', '다음 정제']) {
        h.node('message').value = message;
        await h.chat.sendMessage();
    }
    assert.deepEqual(h.origins, h.requests.filter(r => r.url === '/chat').map(r => r.body.request_id));
    assert.notEqual(h.origins[0], h.origins[1]);
});

test('chat sends review sheet identity separately from the transaction workspace', async()=>{
 const h=await setup();h.reviewSheets=[{document_id:'pdf',kind:'supplier',sheet_name:'내 거래처 검토'}];
 h.node('message').value='내 거래처 검토의 회사명을 대문자로 바꿔줘';await h.chat.sendMessage();
 const request=h.requests.find(r=>r.url==='/chat').body;
 assert.deepEqual(request.review_sheets,h.reviewSheets);assert.equal(request.workspace.row_count,90000);
});
