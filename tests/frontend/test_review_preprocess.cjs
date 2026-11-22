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
test('document action reads and updates 16 review rows while a 3036-row workspace is active',async()=>{
 const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
 const x=createInvestigationHost();x.window.apiClient={newRequestId:()=> 'review-id'};x.load('documents/review_sheet.js');
 const work=x.addSheet('조사 원본',[['해외거래처상호'],...Array.from({length:3036},()=>['원본 보존'])]);
 const rows=Array.from({length:16},(_,i)=>({target:{kind:'supplier',group:'1',category:'회사 '+i,company_name:'  Company '+i+' Co., Ltd.  '},source_pages:[1]}));
 const review=x.window.investigationSheet;await review.ensure('c','d','해외거래처.pdf',rows);
 x.sheets[1].name='내 거래처 목록';work.activate();
 assert.deepEqual(JSON.parse(JSON.stringify(await review.context('c','d'))),[{document_id:'d',kind:'supplier',sheet_name:'내 거래처 목록'}]);
 assert.deepEqual(JSON.parse(JSON.stringify(await review.context('c','missing'))),[]);
 const h=createDOM();h.load('documents/review_preprocess.js');const calls=[];
 const rules=[{operation:'uppercase'},{operation:'remove_words',words:['CO.,','CO.','CO','LTD.','LTD','PTE.','PTE']},{operation:'trim'}];
 const controller=h.window.createReviewPreprocess({messages:h.messages,sheet:review,getConversationId:()=> 'c',isBusy:()=>false,setBusy(){},
 api:{requestJson:async(url,opts)=>{const data=JSON.parse(opts.body);calls.push(data);assert.equal(data.rows.length,16);
  assert.deepEqual(data.operation.rules,rules);return {rows:data.rows.map((r,i)=>({excel_row:r.excel_row,values:['COMPANY '+i]}))};}}});
 const before=x.writes.length;await controller.run({document_id:'d',kind:'supplier',column:'회사명',rules});
 assert.equal(x.writes.length,before);await h.messages.command('적용');
 assert.equal(x.writes.length,before+1);assert.notEqual(x.writes.at(-1).sheet,work.id);
 assert.equal(work.cells.length,3037);assert.ok(work.cells.slice(1).every(r=>r[0]==='원본 보존'));
 assert.deepEqual(JSON.parse(JSON.stringify((await review.read('c','d')).rows.map(r=>r.target.company_name))),Array.from({length:16},(_,i)=>'COMPANY '+i));
});
