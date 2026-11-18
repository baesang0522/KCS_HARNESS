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
    h.controller=h.window.createReviewPreprocess({sheet:h.sheet,
        api:{requestJson:async(url,opts)=>{h.calls.push({url,data:JSON.parse(opts.body)});return h.reply(url,opts);}},
        closeTaskCards:()=>{h.closed++;},getConversationId:()=>h.cid,isBusy:()=>h.busy,setBusy:value=>{h.busy=value;h.controller?.updateControls();}});
    await h.controller.open('pdf','해외.pdf');
    h.select=async name=>{const input=h.node('rules').querySelectorAll('input').find(x=>x.value===name);input.checked=true;await input.emit('change');};
    return h;
}
test('review uses cloned common rules with independent selection, shared preview API and no automatic confirmation',async()=>{
    const h=await setup();assert.equal(h.closed,1);assert.equal(h.node('rules').querySelectorAll('input').length,h.document.getElementById('op-rules').querySelectorAll('input').length);
    await h.select('remove_hangul');await h.node('preview').emit('click');
    assert.equal(h.calls[0].url,'/operations/preview');assert.equal(h.calls[0].data.operation.kind,'preprocess');
    assert.deepEqual(h.calls[0].data.operation.rules,[{operation:'remove_hangul',words:[]}]);
    assert.equal(h.node('apply').disabled,false);await h.node('apply').emit('click');
    assert.equal(h.writes.length,1);assert.equal(h.writes[0][0],'conversation');assert.equal(h.writes[0][1],'pdf');
    assert.deepEqual(Array.from(h.writes[0][3]),['(ACME)']);assert.equal(h.calls.length,1);
    assert.match(h.node('status').textContent,/수정 내용 반영/);assert.equal(h.node('apply').disabled,true);
    assert.equal(h.document.getElementById('op-rules').querySelectorAll('input').some(x=>x.checked),false);
});
test('bracket-only selection preserves rule order; setting edits invalidate preview',async()=>{
    const h=await setup();await h.select('remove_brackets');h.reply=async()=>({rows:[{excel_row:5,values:['회사ACME']}]});
    await h.node('preview').emit('click');assert.deepEqual(h.calls[0].data.operation.rules.map(r=>r.operation),['remove_brackets']);
    await h.select('remove_hangul');assert.equal(h.node('apply').disabled,true);
    const bracketRow=h.node('rules').children.find(row=>row.querySelector('input').value==='remove_brackets');
    await bracketRow.querySelector('button').emit('click');await h.node('preview').emit('click');
    assert.deepEqual(h.calls.at(-1).data.operation.rules.map(r=>r.operation),['remove_brackets','remove_hangul']);
    h.node('words').value='Co.';await h.node('words').emit('input');assert.equal(h.node('apply').disabled,true);
});
test('no rules and invalid server output never enable Excel writes',async()=>{
    const h=await setup();await h.node('preview').emit('click');assert.equal(h.calls.length,0);
    await h.select('remove_hangul');h.reply=async()=>({rows:[{excel_row:6,values:['bad']}]});
    await h.node('preview').emit('click');assert.equal(h.node('apply').disabled,true);await h.node('apply').emit('click');assert.equal(h.writes.length,0);
    assert.match(h.node('status').textContent,/행이나 값/);
});
test('late preview is ignored on conversation reset; old preview cannot be applied in a new conversation',async()=>{
    const h=await setup();await h.select('remove_hangul');let release,entered;
    const started=new Promise(resolve=>entered=resolve);h.reply=()=>{entered();return new Promise(resolve=>release=resolve);};
    const pending=h.node('preview').emit('click');await started;h.controller.reset();h.cid='other';
    release({rows:[{excel_row:5,values:['(ACME)']}]});await pending;assert.equal(h.node('apply').disabled,true);assert.equal(h.node('panel').hidden,true);
    const next=await setup();await next.select('remove_hangul');await next.node('preview').emit('click');next.cid='other';
    await next.node('apply').emit('click');assert.equal(next.writes.length,0);assert.match(next.node('status').textContent,/대화가 바뀌/);
});
test('failed write clears pending result and does not report success or retry automatically',async()=>{
    const h=await setup();await h.select('remove_hangul');await h.node('preview').emit('click');
    h.sheet.writePreprocess=async()=>{throw Error('미리보기 이후 검토 표가 바뀌었어요.');};
    await h.node('apply').emit('click');assert.equal(h.node('apply').disabled,true);assert.match(h.node('status').textContent,/바뀌었/);assert.equal(h.busy,false);
});
