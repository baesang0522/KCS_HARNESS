const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
async function setup(){
    const h=createDOM();h.node=name=>h.document.getElementById('review-clean-'+name);h.cid='conversation';h.busy=false;h.calls=[];h.writes=[];h.closed=0;
    h.snapshot={worksheet_id:'review-sheet',table_id:'review-table',kind:'supplier',row_start:4,column_start:0,column_index:2,values:[['1','제조사','회사(ACME)','1']]};
    h.sheet={preprocessTargets:async()=>[{table_id:'review-table',column_index:2,kind:'supplier',label:'회사명'}],
        readPreprocess:async(cid,did,column)=>{h.readTarget={cid,did,column};return structuredClone(h.snapshot);},
        writePreprocess:async(...args)=>{h.writes.push(args);}};
    h.reply=async()=>({rows:[{excel_row:5,values:['(ACME)']}],changed_count:1});
    h.load('operations/operations_ui.js');h.load('documents/review_preprocess.js');
    h.controller=h.window.createReviewPreprocess({messages:h.messages,sheet:h.sheet,
        api:{requestJson:async(url,opts)=>{h.calls.push({url,data:JSON.parse(opts.body)});return h.reply(url,opts);}},
        closeTaskCards:()=>{h.closed++;},getConversationId:()=>h.cid,isBusy:()=>h.busy,setBusy:value=>{h.busy=value;h.controller?.updateControls();}});
    h.run=(rules=[{operation:'remove_hangul',words:[]}])=>h.controller.run({document_id:'pdf',kind:'supplier',column:'회사명',rules});
    return h;
}
test('review preprocessing previews actual rows and writes only after chat approval',async()=>{
 const h=await setup();await h.run();assert.equal(h.writes.length,0);
 assert.equal(h.calls[0].url,'/operations/preview');assert.deepEqual(h.calls[0].data.operation.rules,[{operation:'remove_hangul',words:[]}]);
 assert.match(h.chatText(),/1행 중 1행/);await h.messages.command('적용');
 assert.equal(h.writes.length,1);assert.equal(h.writes[0][0],'conversation');assert.equal(h.writes[0][1],'pdf');
 assert.deepEqual(Array.from(h.writes[0][3]),['(ACME)']);assert.match(h.chatText(),/조사 조건 반영은 아직/);
 await h.messages.command('적용');assert.equal(h.writes.length,1);
});
test('a new rule sequence revokes the previous offer and preserves rule order',async()=>{
 const h=await setup();await h.run();const old=h.action('적용');
 await h.run([{operation:'remove_brackets'},{operation:'remove_hangul'}]);
 assert.equal(old.disabled,true);await old.emit('click');assert.equal(h.writes.length,0);
 assert.deepEqual(h.calls.at(-1).data.operation.rules.map(r=>r.operation),['remove_brackets','remove_hangul']);
 await h.messages.command('취소');assert.equal(h.writes.length,0);assert.equal(h.action('적용'),undefined);
});
test('invalid server output cannot enable Excel writes',async()=>{
 const h=await setup();h.reply=async()=>({rows:[{excel_row:6,values:['bad']}]});
 await assert.rejects(h.run(),/요청한 행/);assert.equal(h.action('적용'),undefined);assert.equal(h.writes.length,0);
});
test('late preview is ignored on reset and previous conversation cannot be applied',async()=>{
 const h=await setup();let release,entered;const started=new Promise(resolve=>entered=resolve);
 h.reply=()=>{entered();return new Promise(resolve=>release=resolve);};
 const pending=h.run();await started;h.controller.reset();h.cid='other';release({rows:[{excel_row:5,values:['(ACME)']}]});await pending;
 assert.equal(h.action('적용'),undefined);const next=await setup();await next.run();next.cid='other';
 await next.messages.command('적용');assert.equal(next.writes.length,0);assert.match(next.chatText(),/조사가 바뀌/);
});
test('failed write leaves no retryable approval or false completion',async()=>{
 const h=await setup();await h.run();h.sheet.writePreprocess=async()=>{throw Error('미리보기 이후 검토 표가 바뀌었어요.');};
 await h.messages.command('적용');assert.equal(h.action('적용'),undefined);assert.match(h.chatText(),/바뀌었/);assert.doesNotMatch(h.chatText(),/완료했어/);assert.equal(h.busy,false);
});
