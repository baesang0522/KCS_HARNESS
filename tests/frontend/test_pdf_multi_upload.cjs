const test = require('node:test'), assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost} = require('../helpers/investigation_host.cjs');
const supplier = {target:{kind:'supplier',group:'1',category:'제조사',company_name:'회사(ACME)'},source_pages:[1]};
const item = {target:{kind:'item',group:'1',hs_codes:['7208511000'],specification:'SA516-70',requirements:'134mm 이상'},source_pages:[1]};
async function setup(useTaskpane = false) {
    const h=createDOM(), excel=createInvestigationHost();h.excel=excel;h.node=id=>h.document.getElementById(id);
    let serial=0;const docs=new Map();
    h.state={revision:0,conditions:[],reviews:{},document_notes:{},workspace:null};
    h.calls=[];
    h.api={newRequestId:()=>String(++serial).padStart(12,'0'),requestJson:async(url,opts={})=>{
        h.calls.push({url,opts});
        if(url==='/conversations')return {conversation_id:'conversation'};
        if(url.endsWith('/documents'))return {documents:[...docs.values()]};
        if(url.includes('/documents/')&&opts.method==='POST'){
            const did=url.split('/documents/')[1].split('?')[0],doc={document_id:did,filename:opts.body.name,page_count:1,unreadable_pages:[]};
            docs.set(did,doc);return doc;
        }
        if(url.includes('/extractions/')){
            const {document_id:did}=JSON.parse(opts.body), row=docs.get(did).filename.includes('품목')?item:supplier;
            h.state.reviews[did]=[structuredClone(row)];h.state.document_notes[did]=[];
            h.state.conditions.push({source_document_id:did,status:'candidate'});h.state.revision++;
        }
        if(url.includes('/reviews/')){
            const did=url.split('/reviews/')[1],payload=JSON.parse(opts.body);
            assert.deepEqual(payload.expected_rows,h.state.reviews[did]);h.state.reviews[did]=payload.rows;
            h.state.conditions.filter(c=>c.source_document_id===did).forEach(c=>c.status='confirmed');h.state.revision++;
        }
        return structuredClone(h.state);
    }};
    excel.window.apiClient=h.api;excel.load('documents/review_sheet.js');h.window.investigationSheet=excel.window.investigationSheet;
    ['chat/chat.js','documents/documents.js','documents/investigation.js'].forEach(h.load);
    if(useTaskpane){
        // 실제 taskpane의 버튼 → localCommand → previewApply 연결과 busy 처리를 사용한다.
        h.window.apiClient=h.api;
        for(const [factory,key] of [['createTaskMessages','messages'],['createDocumentsController','documents'],['createInvestigationController','investigation']]){
            const create=h.window[factory];h.window[factory]=options=>{h[key]=create(options);return h[key];};
        }
        const createChat=h.window.createChatController;
        h.window.createChatController=options=>{
            h.chat=createChat(options);const initialize=h.chat.initialize;
            h.chat.initialize=()=>{h.initializing=initialize();return h.initializing;};return h.chat;
        };
        h.window.createWriteRecovery=()=>({reset(){},async refresh(){}});
        h.window.createWorkspaceController=()=>({reset(){},dismiss(){},cancelPending(){},setBusy(){},
            referenceTarget:()=>null,isProcessing:()=>false,context:async()=>null});
        h.window.createFormulaUI=()=>({});
        h.window.createFormulaController=()=>({reset(){},dismiss(){},setBusy(){}});
        h.window.createReviewPreprocess=()=>({reset(){}});
        h.window.createAgentController=()=>({async load(){},flush(){},detach(){}});
        h.load('taskpane.js');await h.initializing;
    }else{
    h.chat=h.window.createChatController({api:h.api,getWorkspace:()=>null,closeTaskCards(){},resetTasks(){},handleUIAction(){},
        onConversationChanged:id=>Promise.all([h.documents.load(id),h.investigation.load(id)]),
        onBusy:()=>h.documents?.updateControls()});
    const shared={api:h.api,isBusy:h.chat.isBusy,setBusy:h.chat.setBusy,beginRequest:h.chat.beginRequest,endRequest:h.chat.endRequest,checkRequest:h.chat.checkRequest,reportStop:h.chat.reportStop};
    h.investigation=h.window.createInvestigationController({messages:h.messages,...shared,getWorkspace:()=>null,onChanged:()=>h.documents?.render()});
    h.documents=h.window.createDocumentsController({...shared,beforeUpload:h.investigation.prepare,readConditions:h.investigation.extract,
        reviewInfo:h.investigation.info,applyReview:h.investigation.previewApply,preprocessReview:async()=>{}});
    await h.chat.initialize();
    }
    h.upload=async(...names)=>{h.node('document-file').files=names.map(name=>({name}));await h.node('document-file').emit('change');};
    return h;
}
test('supplier then item from file picker keep distinct editable sheets and per-document confirmation',async()=>{
    const h=await setup();await h.upload('거래처.pdf');
    const supplierSheet=h.excel.sheets[0],did1=Object.keys(h.state.reviews)[0];supplierSheet.cells[4][1]='사용자가 수정한 회사';
    await h.upload('품목.pdf');
    assert.equal(h.excel.sheets.length,2);assert.equal(h.chat.isBusy(),false);assert.equal(h.node('document-add').disabled,false);
    assert.equal(h.node('documents-list').children.length,2);assert.equal(supplierSheet.cells[4][1],'사용자가 수정한 회사');
    assert.deepEqual(h.node('documents-list').querySelectorAll('button').map(b=>b.textContent),[]);
    const did2=Object.keys(h.state.reviews)[1];assert.equal(h.excel.active,h.excel.sheets[1]);
    assert.notEqual(h.excel.sheets[0].id,h.excel.sheets[1].id);
    await h.investigation.previewApply([did1]);assert.equal(h.state.conditions[0].status,'candidate');await h.messages.command('적용');assert.equal(h.state.reviews[did1][0].target.company_name,'사용자가 수정한 회사');
    assert.deepEqual(h.state.reviews[did2],[item]);
    h.excel.sheets[1].cells[4][3]='150mm 이상';await h.investigation.previewApply([did2]);await h.messages.command('적용');
    assert.equal(h.state.reviews[did2][0].target.requirements,'150mm 이상');assert.equal(h.state.reviews[did1][0].target.company_name,'사용자가 수정한 회사');
});
test('one file selection processes both PDFs into separate sheets; reattaching does not overwrite either',async()=>{
    const h=await setup();await h.upload('거래처.pdf','품목.pdf');assert.equal(h.excel.sheets.length,2);
    const before=h.excel.sheets.map(s=>structuredClone(s.cells));await h.upload('거래처.pdf');
    assert.equal(h.excel.sheets.length,3);assert.deepEqual(h.excel.sheets.slice(0,2).map(s=>s.cells),before);
    assert.equal(h.node('document-file').value,'');assert.equal(h.chat.isBusy(),false);
});

test('Excel failure offers only retry until its sheet exists, including after reload',async()=>{
    const h=await setup(),sheet=h.window.investigationSheet,ensure=sheet.ensure;
    sheet.ensure=async()=>{throw Error('Excel 연결 실패');};await h.upload('거래처.pdf');
    const labels=()=>h.node('documents-list').querySelectorAll('button').map(b=>b.textContent);
    assert.deepEqual(labels(),[]);assert.match(h.node('documents-status').textContent,/Excel 연결 실패/);
    await h.investigation.load('conversation');assert.deepEqual(labels(),[]);
    sheet.ensure=ensure;await h.investigation.extract(h.documents.items()[0].document_id,h.documents.items()[0].filename);
    assert.deepEqual(labels(),[]);assert.equal(h.excel.sheets.length,1);
    await h.investigation.load('conversation');assert.deepEqual(labels(),[]);
    assert.equal(h.calls.filter(c=>c.url.includes('/extractions/')).length,1);
});

test('reflection button rechecks an existing edited sheet after a late extraction failure',async()=>{
 const h=await setup(true),sheet=h.window.investigationSheet,ensure=sheet.ensure;
 sheet.ensure=async(...args)=>{await ensure(...args);throw Error('검토 시트 활성화 응답 실패');};
 await h.upload('거래처.pdf');
 const doc=h.documents.items()[0];
 assert.equal(h.investigation.info(doc.document_id).ready,false);
 assert.equal(h.excel.sheets.length,1);
 h.excel.sheets[0].cells[4][1]='실패 후 수정한 회사';
 const button=h.node('documents-apply');
 assert.equal(button.disabled,false,'a stale ready flag must not disable reflection');
 await button.emit('click');
 assert.match(h.chatText(),/실패 후 수정한 회사/);
 assert.equal(h.node('documents-panel').hidden,true);
 await h.messages.command('적용');
 assert.equal(h.state.reviews[doc.document_id][0].target.company_name,'실패 후 수정한 회사');
 assert.equal(h.investigation.info(doc.document_id).ready,true);
 assert.equal(h.calls.filter(c=>c.url.includes('/extractions/')).length,1);
});

test('reflection click after model extraction failure explains the missing review instead of doing nothing',async()=>{
 const h=await setup(true),original=h.api.requestJson;
 h.api.requestJson=async(url,opts)=>{if(url.includes('/extractions/'))throw Error('모델 추출 실패');return original(url,opts);};
 await h.upload('거래처.pdf');
 assert.equal(h.node('documents-apply').disabled,false);
 await h.node('documents-apply').emit('click');
 assert.equal(h.node('documents-panel').hidden,false);
 assert.match(h.node('documents-status').textContent,/추출.*완료.*재시도/);
 assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,0);
 assert.equal(h.action('적용'),undefined);
});

for(const phase of ['server','excel','metadata']) test(`reflection waiting on ${phase} can be stopped and chat resumes before the late response`,async()=>{
 const h=await setup(true);await h.upload('거래처.pdf');
 const original=h.api.requestJson,read=h.window.investigationSheet.read,isReady=h.window.investigationSheet.isReady;
 let entered,release;
 const waiting=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
 if(phase==='excel')h.window.investigationSheet.read=async(...args)=>{entered();await held;return read(...args);};
 else if(phase==='metadata')h.window.investigationSheet.isReady=async(...args)=>{entered();await held;return isReady(...args);};
 else h.api.requestJson=async(url,opts)=>{
  if(url.endsWith('/investigation')){entered();await held;return structuredClone(h.state);}
  return original(url,opts);
 };
 assert.equal(h.node('documents-apply').disabled,false);
 const clicking=h.node('documents-apply').emit('click');await waiting;
 const send=h.document.querySelector('.send');
 try{
  assert.equal(send.disabled,false,'reflection must expose the existing stop action while waiting');
  assert.equal(send.getAttribute('aria-label'),'요청 중지');
  await h.node('composer').emit('submit');
  await Promise.race([clicking,new Promise((_,reject)=>{setTimeout(()=>reject(Error('reflection stop did not release chat')),500).unref();})]);
  assert.equal(h.chat.isBusy(),false);
  assert.match(h.chatText(),/수정.*중지/);
  assert.equal(h.action('적용'),undefined);
  assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,0);
  h.window.investigationSheet.read=read;
  h.window.investigationSheet.isReady=isReady;
  h.api.requestJson=async(url,opts)=>url==='/chat'?{answer:'다시 응답합니다.',ui_action:null}:original(url,opts);
  h.node('message').value='현재 상태 알려줘';await h.chat.sendMessage();
  assert.match(h.chatText(),/다시 응답합니다/);
 }finally{release();await clicking;}
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.action('적용'),undefined,'late reads must never resurrect a cancelled approval');
 assert.equal(h.chat.isBusy(),false);
});

test('reflection button previews both PDFs without typing and saves only after chat approval',async()=>{
 const h=await setup();await h.upload('거래처.pdf','품목.pdf');const ids=Object.keys(h.state.reviews);
 h.excel.sheets[0].cells[4][1]='수정된 회사';h.excel.sheets[1].cells[4][3]='150mm 이상';
 h.node('message').value='아직 보내지 않은 질문';assert.equal(h.node('documents-apply').disabled,false);
 await h.node('documents-apply').emit('click');assert.equal(h.node('documents-panel').hidden,true);
 assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,0);assert.match(h.chatText(),/PDF 2개/);
 assert.equal(h.node('message').value,'아직 보내지 않은 질문');assert.equal(h.calls.some(c=>c.url==='/chat'),false);
 await h.messages.command('적용');assert.equal(h.state.reviews[ids[0]][0].target.company_name,'수정된 회사');
 assert.equal(h.state.reviews[ids[1]][0].target.requirements,'150mm 이상');assert(h.state.conditions.every(c=>c.status==='confirmed'));
 assert.equal(h.node('documents-panel').hidden,true);
});
test('normal reading and sheet creation never show retry guidance; actual failure does',async()=>{
 const h=await setup(),original=h.api.requestJson;let release,entered;
 const started=new Promise(resolve=>entered=resolve);
 h.api.requestJson=async(url,opts)=>{if(url.includes('/extractions/')){entered();await new Promise(resolve=>release=resolve);}return original(url,opts);};
 const uploading=h.upload('거래처.pdf');await started;
 assert.match(h.node('documents-list').textContent,/추출 중/);assert.doesNotMatch(h.node('documents-list').textContent,/재시도/);
 release();await uploading;h.api.requestJson=original;assert.doesNotMatch(h.node('documents-list').textContent,/재시도/);
 const ensure=h.window.investigationSheet.ensure;h.window.investigationSheet.ensure=async()=>{throw Error('시트 작성 실패');};
 await h.upload('품목.pdf');assert.match(h.node('documents-list').textContent,/추출 재시도/);
 h.window.investigationSheet.ensure=ensure;const doc=h.documents.items()[1];await h.investigation.extract(doc.document_id,doc.filename);
 assert.doesNotMatch(h.node('documents-list').textContent,/재시도/);
});

test('failed PDF model extraction retries the same attachment with a new request and restores editing',async()=>{
 const h=await setup(),original=h.api.requestJson,attempts=[];
 h.api.requestJson=async(url,opts)=>{
  if(url.includes('/extractions/')){
   attempts.push({url,document:JSON.parse(opts.body).document_id});
   if(attempts.length===1)throw Error('모델 응답 실패');
  }
  return original(url,opts);
 };
 await h.upload('거래처.pdf');
 assert.equal(h.documents.items().length,1);assert.equal(h.chat.isBusy(),false);
 assert.match(h.node('documents-list').textContent,/추출 실패/);
 const doc=h.documents.items()[0];
 assert.equal(await h.investigation.extract(doc.document_id,doc.filename),true);
 assert.equal(attempts.length,2);assert.equal(attempts[0].document,attempts[1].document);
 assert.notEqual(attempts[0].url,attempts[1].url);
 assert.equal(h.calls.filter(c=>c.url.includes('/documents/')&&c.opts.method==='POST').length,1);
 h.excel.sheets[0].cells[4][1]='재시도 후 수정';
 await h.investigation.previewApply();await h.messages.command('적용');
 assert.equal(h.state.reviews[doc.document_id][0].target.company_name,'재시도 후 수정');
 assert.equal(h.chat.isBusy(),false);
});
test('one changed review among three only reflects that PDF and emits one completion',async()=>{
 const h=await setup();await h.upload('거래처.pdf','품목.pdf','추가거래처.pdf');const ids=Object.keys(h.state.reviews);
 h.excel.sheets[1].cells[4][3]='150mm 이상';const untouched=structuredClone([h.state.reviews[ids[0]],h.state.reviews[ids[2]]]);
 const messages=[],say=h.messages.say;h.messages.say=(text)=>{messages.push(text);return say(text);};
 await h.node('documents-apply').emit('click');assert.match(h.chatText(),/PDF 1개의 수정 내용/);await h.messages.command('적용');
 assert.deepEqual(h.calls.filter(c=>c.url.includes('/reviews/')).map(c=>c.url.split('/reviews/')[1]),[ids[1]]);
 assert.deepEqual([h.state.reviews[ids[0]],h.state.reviews[ids[2]]],untouched);
 assert.deepEqual(messages,['PDF 1개의 수정 내용을 반영했어요.']);
 assert.deepEqual(h.state.conditions.map(c=>c.status),['candidate','confirmed','candidate']);
});
test('multiple changed PDFs emit one completion; confirmed unchanged reviews do not post again',async()=>{
 const h=await setup();await h.upload('거래처.pdf','품목.pdf','추가거래처.pdf');
 h.excel.sheets[0].cells[4][1]='회사 A';h.excel.sheets[1].cells[4][3]='150mm 이상';h.excel.sheets[2].cells[4][1]='회사 B';
 const messages=[],say=h.messages.say;h.messages.say=(text)=>{messages.push(text);return say(text);};
 await h.investigation.previewApply();await h.messages.command('적용');
 assert.deepEqual(messages,['PDF 3개의 수정 내용을 반영했어요.']);assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,3);
 await h.investigation.previewApply();assert.equal(messages.at(-1),'반영할 수정 내용이 없어요.');assert.equal(h.action('적용'),undefined);
 assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,3);
});
test('unchanged initial reviews can be confirmed once and saved-record failure remains retryable',async()=>{
 const h=await setup();await h.upload('거래처.pdf','품목.pdf');
 await h.investigation.previewApply();assert.match(h.chatText(),/PDF 2개의 검토 내용/);await h.messages.command('적용');
 assert(h.state.conditions.every(c=>c.status==='confirmed'));
 h.excel.sheets[0].cells[4][1]='재시도 회사';const mark=h.window.investigationSheet.markSaved;
 h.window.investigationSheet.markSaved=async()=>{throw Error('기록 실패');};
 await h.investigation.previewApply();await h.messages.command('적용');assert.match(h.node('documents-status').textContent,/기록 실패/);
 const count=h.calls.filter(c=>c.url.includes('/reviews/')).length;h.window.investigationSheet.markSaved=mark;
 await h.investigation.previewApply();await h.messages.command('적용');
 assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,count);assert.match(h.node('documents-status').textContent,/PDF 1개의 수정 내용을 반영/);
});
test('a failed batch reports partial completion once and retries only remaining changes',async()=>{
 const h=await setup();await h.upload('거래처.pdf','품목.pdf');const ids=Object.keys(h.state.reviews);
 h.excel.sheets[0].cells[4][1]='반영된 회사';h.excel.sheets[1].cells[4][3]='150mm 이상';
 const original=h.api.requestJson,messages=[],say=h.messages.say;h.messages.say=text=>{messages.push(text);return say(text);};
 h.api.requestJson=async(url,opts)=>{if(url.endsWith('/reviews/'+ids[1]))throw Error('저장 실패');return original(url,opts);};
 await h.investigation.previewApply();await h.messages.command('적용');
 assert.deepEqual(messages,['PDF 1개는 반영했지만 나머지 반영을 중단했어요. 저장 실패']);
 assert.equal(h.state.reviews[ids[0]][0].target.company_name,'반영된 회사');
 assert.equal(h.state.reviews[ids[1]][0].target.requirements,item.target.requirements);
 h.api.requestJson=original;await h.investigation.previewApply();await h.messages.command('적용');
 assert.equal(messages.at(-1),'PDF 1개의 수정 내용을 반영했어요.');
 assert.equal(h.calls.filter(c=>c.url.endsWith('/reviews/'+ids[0])).length,1);
});


test('renaming specification header on an existing item sheet still previews and confirms edited models',async()=>{
 const h=await setup();await h.upload('품목.pdf');const did=Object.keys(h.state.reviews)[0],sheet=h.excel.sheets[0];
 delete h.excel.settings.get('kcs.pdf-review.conversation.'+did).entries[0].column_ids;
 sheet.cells[3][2]='모델명';sheet.cells[4][2]='EDITED-MODEL';
 await h.node('documents-apply').emit('click');assert.equal(h.node('documents-panel').hidden,true);
 assert.match(h.chatText(),/PDF 1개의 수정 내용/);assert.equal(h.calls.filter(c=>c.url.includes('/reviews/')).length,0);
 await h.messages.command('적용');assert.equal(h.state.reviews[did][0].target.specification,'EDITED-MODEL');
 assert.match(h.node('documents-status').textContent,/PDF 1개의 수정 내용을 반영했어요/);
});
