const test=require('node:test'),assert=require('node:assert/strict');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
test('recovery captures raw values and compares without writing; changed identities or moved columns never silently match',async()=>{
 const host=createInvestigationHost();host.load('operations/write_recovery.js');
 const f=host.workspace(['id','입력','결과'],[[1,'a',''],[2,'b','']]);
 const info=await host.window.workspaceTable.layout(host.context,f.work),api=host.window.writeRecoverySheet;
 const proof=await api.capture(host.context,info.sheet,info,[{row_start:1,row_count:2,column_start:2,column_id:String(f.work.columns[1].column_id)}],()=>[['A'],['B']]);
 assert.equal((await api.observe(proof)).values[0],proof.blocks[0].before);
 f.sheet.cells[1][2]='A';f.sheet.cells[2][2]='B';const before=structuredClone(f.sheet.cells),writes=host.writes.length;
 assert.equal((await api.observe(proof)).values[0],proof.blocks[0].expected);
 assert.deepEqual(f.sheet.cells,before);assert.equal(host.writes.length,writes);
 f.sheet.cells[1][0]=99;assert.notEqual((await api.observe(proof)).identities[0],proof.blocks[0].identities);
 host.moveColumn(f.sheet,2,1);await assert.rejects(api.observe(proof),/위치/);
});
test('a failure to persist prewrite evidence prevents value writes',async()=>{
 const host=createInvestigationHost(),f=host.workspace(['id','입력','결과'],[[1,'a','old']]);
 const snapshot=await host.window.operationsSheet.read(f.work,f.target,[f.work.columns[0].column_id],()=>{},()=>{},f.work.columns[1].column_id);
 const before=structuredClone(f.sheet.cells);
 await assert.rejects(host.window.operationsSheet.write(snapshot,[['new']],['결과'],{mode:'existing',column_id:f.work.columns[1].column_id},()=>{},null,async()=>{throw Error('증거 저장 실패');}),/증거 저장 실패/);
 assert.deepEqual(f.sheet.cells,before);
});

test('recovery UI records a lost acknowledgement and restores metadata without reusing the write endpoint',async()=>{
 const {createDOM}=require('../helpers/taskpane_dom.cjs');const h=createDOM(),host=createInvestigationHost();
 h.sandbox.Excel=host.Excel;h.load('workspace/table_reader.js');h.load('operations/write_recovery.js');
 const f=host.workspace(['id','입력','결과'],[[1,'a','']]),info=await host.window.workspaceTable.layout(host.context,f.work);
 const proof=await h.window.writeRecoverySheet.capture(host.context,info.sheet,info,[{row_start:1,row_count:1,column_start:2,column_id:String(f.work.columns[1].column_id)}],()=>[['A']]);
 f.sheet.cells[1][2]='A';const before=structuredClone(f.sheet.cells),requests=[];let restored=0,busy=false;
 const job={kind:'operation',job_id:'job',status:'UNKNOWN',conversation_id:'original',worksheet_id:f.work.worksheet_id,evidence:proof,checks:[]};
 const controller=h.window.createWriteRecovery({messages:h.messages,getConversationId:()=> 'active',getWorkspace:()=>f.work,isBusy:()=>busy,setBusy:v=>busy=v,
 api:{requestJson:async(url,options)=>{requests.push({url,options});if(!options)return [job];return {...job,status:'APPLIED',checks:[{result:'completed'}]};}}});
 controller.remember('job',async()=>{restored++;});await controller.refresh();
 const check=h.document.getElementById('conversation').querySelector('button');await check.emit('click');
 assert.equal(restored,1);assert.deepEqual(f.sheet.cells,before);assert.equal(host.writes.length,0);
 assert.match(requests.at(-1).url,/check\?conversation_id=original/);
 assert.equal(JSON.parse(requests.at(-1).options.body).values[0],proof.blocks[0].expected);
 assert.equal(check.disabled,true);
});

test('manual recovery conclusion requires a chat note and confirmation without rewriting cells',async()=>{
 const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();h.load('operations/write_recovery.js');let cid='active';const requests=[];
 const job={kind:'operation',job_id:'job',status:'UNKNOWN',conversation_id:'original',evidence:null,checks:[]};
 const controller=h.window.createWriteRecovery({messages:h.messages,getConversationId:()=>cid,getWorkspace:()=>null,isBusy:()=>false,setBusy(){},
 api:{requestJson:async(url,options)=>{if(!options)return [job];requests.push({url,body:JSON.parse(options.body)});return {...job,checks:[{result:'partial'}]};}}});
 await controller.refresh();await h.action('일부 반영 기록').emit('click');assert.equal(requests.length,0);
 await h.messages.command('2~10행에서 2~5행만 확인됨');assert.equal(requests.length,0);
 await h.messages.command('적용');assert.equal(requests.length,1);assert.equal(requests[0].body.conclusion,'partial');
 assert.match(requests[0].url,/check/);assert.equal(requests[0].body.note,'2~10행에서 2~5행만 확인됨');
 await h.action('판단 불가 기록').emit('click');await h.messages.command('범위를 다시 확인해야 함');cid='another';
 await h.messages.command('적용');assert.equal(requests.length,1);assert.match(h.chatText(),/조사나 작업표가 바뀌/);
});
