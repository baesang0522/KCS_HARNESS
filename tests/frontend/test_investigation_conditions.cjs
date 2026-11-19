const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');
const row = (name='Baoshan 宝山') => ({target:{kind:'supplier',group:'1',category:'제조사',company_name:name},source_pages:[1]});
async function setup() {
    const h=createDOM();h.node=id=>h.document.getElementById(id);h.state={revision:0,conditions:[],document_notes:{},reviews:{},workspace:null};
    h.workspace=null;h.requests=[];h.busy=false;h.serial=0;h.drafts={};h.writes=0;
    h.load('documents/review_sheet.js');
    h.sheet={isReady:async(cid,did)=>!!h.drafts[did],canonical:h.window.investigationSheet.canonical,
        ensure:async(cid,did,name,rows)=>{h.opened={cid,did,name};if(!h.drafts[did]){h.writes++;h.drafts[did]={baseline:structuredClone(rows),rows:structuredClone(rows)};}},
        read:async(cid,did)=>structuredClone(h.drafts[did]||null),
        markSaved:async(cid,did,rows)=>{h.drafts[did].baseline=structuredClone(rows);}};
    h.reply=async(url,opts)=>{
        if(url.includes('/extractions/'))h.state={...h.state,revision:h.state.revision+1,document_notes:{doc:['하단 누락']},reviews:{doc:[row()]},conditions:[{source_document_id:'doc',status:'candidate'}]};
        if(url.endsWith('/workspace'))h.state={...h.state,workspace:JSON.parse(opts.body)};
        if(url.includes('/reviews/')){h.saved=JSON.parse(opts.body);h.state={...h.state,revision:h.state.revision+1,reviews:{doc:h.saved.rows},conditions:h.saved.rows.map(()=>({source_document_id:'doc',status:'confirmed'}))};}
        return structuredClone(h.state);
    };
    h.load('documents/investigation.js');
    h.controller=h.window.createInvestigationController({messages:h.messages,sheet:h.sheet,
        api:{newRequestId:()=> 'request-'+ ++h.serial,requestJson:async(url,opts={})=>{h.requests.push({url,opts});return h.reply(url,opts);}},
        getWorkspace:()=>h.workspace,isBusy:()=>h.busy,setBusy:v=>{h.busy=v;},beginRequest:()=>h.run={controller:new AbortController(),cancelled:false},
        endRequest:()=>{},checkRequest:run=>{if(run.cancelled)throw new DOMException('취소','AbortError');},reportStop:async()=>{}});
    await h.controller.load('conversation');return h;
}
test('extracts once, opens editable sheet and reopens without overwriting user cells',async()=>{
    const h=await setup();await h.controller.extract('doc','해외거래처.pdf');
    assert.equal(h.writes,1);assert.equal(h.opened.name,'해외거래처.pdf');assert.equal(h.controller.info('doc').ready,true);
    h.drafts.doc.rows[0].target.company_name='직접 수정';await h.controller.extract('doc','해외거래처.pdf');
    assert.equal(h.requests.filter(r=>r.url.includes('/extractions/')).length,1);assert.equal(h.writes,1);
    assert.equal(h.drafts.doc.rows[0].target.company_name,'직접 수정');
    await assert.rejects(h.controller.ensureSynced(),/수정 내용 반영/);
    await h.controller.apply('doc');assert.equal(h.saved.rows[0].target.company_name,'직접 수정');
    assert.equal(h.saved.expected_rows[0].target.company_name,'Baoshan 宝山');await h.controller.ensureSynced();
    assert.equal(h.busy,false);
});
test('new rows, deleted rows and reorder are read from the sheet, never row-position IDs',async()=>{
    const h=await setup();await h.controller.extract('doc','파일.pdf');h.drafts.doc.rows=[row('추가 기업'),row('다른 기업')];
    await h.controller.apply('doc');assert.equal(h.saved.rows.length,2);
    h.drafts.doc.rows.reverse();await h.controller.ensureSynced();
    h.drafts.doc.rows=[];await h.controller.apply('doc');assert.deepEqual(h.saved.rows,[]);
});
test('first confirmation saves unchanged rows; response-metadata failure can be retried',async()=>{
    const h=await setup();await h.controller.extract('doc','파일.pdf');const mark=h.sheet.markSaved;
    h.sheet.markSaved=async()=>{throw Error('시트 기록 실패');};await h.controller.apply('doc');
    assert.equal(h.requests.filter(r=>r.url.includes('/reviews/')).length,1);assert.match(h.node('documents-status').textContent,/기록 실패/);
    h.sheet.markSaved=mark;await h.controller.apply('doc');assert.equal(h.requests.filter(r=>r.url.includes('/reviews/')).length,1);
});
test('API conflict keeps Excel edits and their baseline; invalid sheet never posts',async()=>{
    const h=await setup();await h.controller.extract('doc','파일.pdf');h.drafts.doc.rows=[row('수정')];const original=h.reply;
    h.reply=async(url,opts)=>{if(url.includes('/reviews/'))throw Error('다른 창에서 갱신');return original(url,opts);};
    await h.controller.apply('doc');assert.equal(h.drafts.doc.rows[0].target.company_name,'수정');assert.equal(h.drafts.doc.baseline[0].target.company_name,'Baoshan 宝山');
    const count=h.requests.length;h.sheet.read=async()=>{throw Error('열 이름 변경');};await h.controller.apply('doc');
    assert.equal(h.requests.slice(count).some(r=>r.url.includes('/reviews/')),false);assert.match(h.node('documents-status').textContent,/열 이름/);
});
test('automatically binds one workspace and rejects a second without relinking',async()=>{
    const h=await setup();h.workspace={workspace_id:'work',worksheet_id:'sheet',table_id:'table',sheet_name:'조사',task_type:'investigation'};
    await h.controller.prepare();assert.equal(h.state.workspace.workspace_id,'work');
    assert.throws(()=>h.controller.validateWorkspace(null),/새 대화/);
    h.workspace={...h.workspace,workspace_id:'other'};await assert.rejects(h.controller.prepare(),/새 대화/);
    assert.equal(h.requests.filter(r=>r.url.endsWith('/workspace')).length,1);
});
test('cancellation and conversation changes ignore late model responses and never write a sheet',async()=>{
    for(const switchConversation of [false,true]){
        const h=await setup(),original=h.reply;let release,entered;const started=new Promise(resolve=>entered=resolve);
        h.reply=async(url,opts)=>{if(url.includes('/extractions/')){entered();return new Promise(resolve=>release=()=>resolve({...h.state,reviews:{doc:[row()]},document_notes:{doc:[]}}));}return original(url,opts);};
        const pending=h.controller.extract('doc','파일.pdf');await started;
        if(switchConversation)await h.controller.load('other');else h.run.cancelled=true;
        release();await pending;assert.equal(h.writes,0);assert.equal(h.busy,false);
    }
});
test('refresh or binding failure stops before invoking the model',async()=>{
    const h=await setup();h.reply=async()=>{throw Error('서버 연결 실패');};await h.controller.extract('doc','파일.pdf');
    assert.equal(h.requests.some(r=>r.url.includes('/extractions/')),false);assert.match(h.node('documents-status').textContent,/서버 연결 실패/);
});
test('Excel write failure retains extracted data and retry does not invoke model again',async()=>{
    const h=await setup(),ensure=h.sheet.ensure;h.sheet.ensure=async()=>{throw Error('Excel 연결 필요');};
    await h.controller.extract('doc','파일.pdf');assert.equal(h.controller.info('doc').ready,false);
    await h.controller.load('conversation');assert.equal(h.controller.info('doc').ready,false);
    h.sheet.ensure=ensure;await h.controller.extract('doc','파일.pdf');assert.equal(h.writes,1);
    await h.controller.load('conversation');assert.equal(h.controller.info('doc').ready,true);
    assert.equal(h.requests.filter(r=>r.url.includes('/extractions/')).length,1);
});
