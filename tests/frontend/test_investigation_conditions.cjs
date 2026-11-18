const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

async function setup() {
    const h = createDOM(); h.node = id => h.document.getElementById('investigation-' + id);
    h.state = {revision:0,goal:'문서에 나온 대상 찾기',conditions:[],columns:[],workspace:null,active_condition_id:null,document_notes:{}};
    h.requests = []; h.busy = false; h.serial = 0; h.workspace = null;
    h.reply = async (url, options) => {
        if (url.includes('/extractions/')) {
            h.state = {...h.state,revision:h.state.revision+1,conditions:[{condition_id:'condition-1',title:'회사 <img>',description:'A사와 관계사',status:'candidate',column_ids:[],
                evidence:[{document_id:'doc',filename:'<img>.pdf',page_number:1,quote:'A <script> B'}]}],document_notes:{doc:['목록 하단 누락']}};
        } else if (options.method === 'PUT') {
            const data = JSON.parse(options.body); h.saved = data;
            h.state = {...h.state,...data,revision:h.state.revision+1};
            if (data.bind_workspace) h.state.columns = data.workspace.columns;
        }
        return structuredClone(h.state);
    };
    h.load('documents/investigation.js');
    h.controller = h.window.createInvestigationController({
        api:{newRequestId:()=> 'request-' + ++h.serial,requestJson:async(url,options={})=>{h.requests.push({url,options});return h.reply(url,options);}},
        getWorkspace:async()=>h.workspace,isBusy:()=>h.busy,setBusy:value=>{h.busy=value;h.controller?.updateControls();},
        beginRequest:()=>{h.run={controller:new AbortController(),cancelled:false};return h.run;},
        endRequest:()=>{},checkRequest:run=>{if(run.cancelled)throw new DOMException('취소','AbortError');},reportStop:async()=>{}
    });
    await h.controller.load('conversation-1');
    h.row = () => h.node('conditions').querySelector('article');
    h.button = text => h.row().querySelectorAll('button').find(b=>b.textContent===text);
    return h;
}

test('extract, edit, confirm and save preserve evidence and never call Excel or operation endpoints', async()=>{
    const h=await setup();await h.controller.extract('doc');
    assert.equal(h.node('panel').hidden,false);
    assert.match(h.node('warnings').textContent,/하단/);
    assert.equal(h.row().querySelectorAll('img,script').length,0);
    assert.match(h.row().textContent,/A <script> B/);
    h.row().querySelector('textarea').value='사용자가 수정한 조사 조건';
    await h.row().querySelector('textarea').emit('input');
    h.row().querySelector('select').value='confirmed';
    h.node('active').value='condition-1';
    await h.node('save').emit('click');
    assert.equal(h.saved.conditions[0].description,'사용자가 수정한 조사 조건');
    assert.equal(h.saved.conditions[0].status,'confirmed');
    assert.equal(h.saved.active_condition_id,'condition-1');
    assert.equal('evidence' in h.saved.conditions[0],false);
    assert(h.requests.every(r=>r.url.includes('/investigation')));
    assert.match(h.node('status').textContent,/저장했어요/);
});

test('repeat document read and document changes do not overwrite an unsaved user edit',async()=>{
    const h=await setup();await h.controller.extract('doc');
    const text=h.row().querySelector('textarea');text.value='저장 전 수정';await text.emit('input');
    await h.controller.extract('doc');
    assert.match(h.node('status').textContent,/먼저 저장/);
    await h.controller.refresh();
    assert.equal(text.value,'저장 전 수정');
    await h.node('save').emit('click');
    await h.controller.extract('doc');
    assert.equal(h.requests.filter(r=>r.url.includes('/extractions/')).length,1);
    assert.equal(h.row().querySelector('textarea').value,'저장 전 수정');
});

test('stale save shows conflict without discarding draft; explicit reload shows server state',async()=>{
    const h=await setup();await h.controller.extract('doc');
    const original=h.reply;
    h.reply=async(url,options)=>{if(options.method==='PUT')throw Error('조사 조건이 갱신됐습니다.');return original(url,options);};
    h.row().querySelector('textarea').value='보존해야 할 편집';
    await h.row().querySelector('textarea').emit('input');
    await h.node('save').emit('click');
    assert.equal(h.row().querySelector('textarea').value,'보존해야 할 편집');
    assert.match(h.node('status').textContent,/갱신/);
    await h.node('reload').emit('click');
    assert.equal(h.row().querySelector('textarea').value,'A사와 관계사');
});

test('condition add/remove and workspace column binding are explicit saved actions',async()=>{
    const h=await setup();await h.controller.extract('doc');
    h.workspace={workspace_id:'work',worksheet_id:'sheet',table_id:'table',sheet_name:'조사',columns:[{column_id:'company',header:'상호'}]};
    await h.node('bind').emit('click');
    assert.equal(h.saved.bind_workspace,true);
    const checkbox=h.row().querySelector('fieldset').querySelector('input');checkbox.checked=true;
    await h.node('save').emit('click');
    assert.deepEqual(h.saved.conditions[0].column_ids,['company']);
    await h.button('조건 제거').emit('click');
    await h.node('add').emit('click');
    const row=h.node('conditions').querySelectorAll('article').at(-1);
    row.querySelector('input').value='기간';row.querySelector('textarea').value='사용자가 지정한 기간';
    await h.node('save').emit('click');
    assert.equal(h.saved.conditions.length,1);
    assert.equal(h.saved.conditions[0].condition_id,null);
    assert.equal(h.saved.conditions[0].title,'기간');
});

test('cancellation and conversation changes ignore a late extraction result',async()=>{
    for(const switchConversation of [false,true]){
        const h=await setup();const original=h.reply;let release,entered;
        const started=new Promise(resolve=>{entered=resolve;});
        h.reply=async(url,options)=>{if(url.includes('/extractions/')){entered();return new Promise(resolve=>{release=()=>resolve({...h.state,conditions:[{condition_id:'late',title:'이전 조사',description:'이전 자료',status:'candidate',evidence:[]}]});});}return original(url,options);};
        const pending=h.controller.extract('doc');await started;
        assert.equal(h.run.request.conversation_id,'conversation-1');
        if(switchConversation)await h.controller.load('conversation-2');
        else h.run.cancelled=true;
        release();await pending;
        assert.equal(h.node('conditions').textContent.includes('이전 조사'),false);
        assert.equal(h.busy,false);
        if(!switchConversation)assert.match(h.node('status').textContent,/중지/);
    }
});

test('failed refresh does not start extraction using stale revision',async()=>{
    const h=await setup();h.reply=async()=>{throw Error('서버 연결 실패');};
    await h.controller.extract('doc');
    assert.equal(h.requests.some(r=>r.url.includes('/extractions/')),false);
    assert.match(h.node('status').textContent,/연결 실패/);
});


test('late refresh cannot replace edits made while it was loading',async()=>{
    const h=await setup();await h.controller.extract('doc');let release;
    h.reply=()=>new Promise(resolve=>{release=resolve;});
    const pending=h.controller.refresh(true);
    const input=h.row().querySelector('textarea');input.value='조회 중 수정';await input.emit('input');
    release(structuredClone(h.state));await pending;
    assert.equal(h.row().querySelector('textarea').value,'조회 중 수정');
    assert.match(h.node('status').textContent,/유지/);
});
