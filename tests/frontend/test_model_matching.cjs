const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
async function setup(values=['SA516-70','MODEL: UNKNOWN','SA516-70','SM490A / SA516-70',''],role='model_spec'){
 const h=createDOM(),host=createInvestigationHost(),f=host.workspace(['id','모델규격명','메모'],values.map((v,i)=>[i+1,v,'메모'+i]));
 f.work.columns[0].role=role;
 let stored={...f.work,workspace_id:'work',target:f.target},busy=false,controller,job;
 const requests=[],completed=[];h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
 h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);}};
 h.window.sourceColumns={list:async()=>[]};h.window.createSimilarityController=()=>({reset(){},busy(){}});
 const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url==='/operation-jobs')return job={source:body,model_references:[{model:'SA516-70',category:'열처리 강종'}]};
  if(url.includes('/preview')){
   if(h.cancelOnPreview){controller.cancelPending();throw new DOMException('중지','AbortError');}
   const rows=body.rows.map(r=>({...r,values:r.values[0]==='SA516-70'?['SA516-70','열처리 강종']:r.values[0]==='SM490A / SA516-70'?['SA516-70','열처리 강종']:['','']}));
   return {headers:['모델명','모델명 종류'],changed_count:rows.filter(r=>r.values[0]).length,rows};
  }
  return job;
 }};
 ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js','operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/result_dependencies.js','workspace/workspace_actions.js','workspace/workspace.js'].forEach(h.load);
 h.captureWorkspaceActions();
 controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
  setBusy:v=>{busy=v;controller?.setBusy(v);},complete:message=>completed.push(message),enterConversation(){},beforeApply:async()=>{if(h.unsavedPDF)throw Error('검토 시트에 반영하지 않은 수정');}});
 await h.workspaceActions.restore();
 async function preview(output){await controller.configure({kind:'extract',column_ids:[f.work.columns[0].column_id],extraction_mode:'pdf',output});await controller.previewOperation();}
 return {...f,h,host,controller,requests,completed,preview,get stored(){return stored;}};
}
test('PDF preview shows both data columns and writes the paired classifications only after approval',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells);await f.preview();
 assert.deepEqual(f.sheet.cells,before);
 assert.match(f.h.chatText(),/5행 중 3행/);assert.match(f.h.chatText(),/모델명 종류/);assert.match(f.h.chatText(),/열처리 강종/);assert.match(f.h.chatText(),/복수 후보 0행/);
 assert.match(f.h.chatText(),/가장 긴 모델만 추출/);
 assert.doesNotMatch(f.h.chatText(),/사용할 방식을 골라|추출상태/);
 const request=f.requests.find(r=>r.url==='/operation-jobs').body;assert.equal(request.model_spec_column_id,f.work.columns[0].column_id);
 assert.equal(f.requests.filter(r=>r.url.includes('/preview'))[0].body.rows.length,4);
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells[0],['id','모델규격명','모델명','모델명 종류','메모']);
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r.slice(2,4)),[['SA516-70','열처리 강종'],['',''],['SA516-70','열처리 강종'],['SA516-70','열처리 강종'],['','']]);
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>[r[1],r[4]]),before.slice(1).map(r=>r.slice(1)));
 assert.equal(f.stored.result_dependencies.length,1);
 assert.equal(f.requests.filter(r=>r.body.status==='APPLIED').at(-1).body.result_column_ids.length,2);
});
test('scope, custom placement and cancel reuse existing preview flow',async()=>{
 const f=await setup();await f.controller.changeScope({mode:'replace',condition:{column_id:f.work.columns[0].column_id,operator:'equals',value:'SA516-70'}});
 await f.preview({mode:'new',name:'추출 모델',anchor:f.work.columns[1].column_id,side:'after'});
 assert.equal(f.requests.find(r=>r.url.includes('/preview')).body.selected_count,2);
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells[0].slice(3),['추출 모델','추출 모델 종류']);
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r.slice(3)),[['SA516-70','열처리 강종'],['',''],['SA516-70','열처리 강종'],['',''],['','']]);
 const g=await setup();await g.preview();await g.h.messages.command('취소');assert.equal(g.sheet.cells[0].length,3);
});
test('changed source and unsynced PDF block writes; existing output cannot drop classification',async()=>{
 const f=await setup();await f.preview();f.sheet.cells[1][1]='manual';const before=structuredClone(f.sheet.cells);
 await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);
 const g=await setup();await g.preview();g.h.unsavedPDF=true;const original=structuredClone(g.sheet.cells);
 await g.h.messages.command('적용');assert.deepEqual(g.sheet.cells,original);assert(!g.requests.some(r=>r.url.includes('/apply')));
 const k=await setup();await assert.rejects(()=>k.preview({mode:'existing',column_id:k.work.columns[1].column_id}),/함께 저장할 새 결과 열/);
 assert.equal(k.sheet.cells[0].length,3);
});
test('unique model values are batched without dropping rows, and cancellation leaves cells intact',async()=>{
 const values=Array.from({length:502},(_,i)=>'MODEL'+i),f=await setup(values.concat(values));await f.preview();
 assert.deepEqual(f.requests.filter(r=>r.url.includes('/preview')).map(r=>r.body.rows.length),[250,250,2]);
 await f.h.messages.command('적용');assert.equal(f.sheet.cells.length,1005);assert(f.sheet.cells.slice(1).every(r=>r[2]===''&&r[3]===''));
 const g=await setup(values);g.h.cancelOnPreview=true;const before=structuredClone(g.sheet.cells);await g.preview();
 assert.deepEqual(g.sheet.cells,before);assert(g.requests.some(r=>r.body.status==='CANCELLED'));
});

test('explicit reference or result input reaches PDF preview and apply without assigning a role',async()=>{
 for(const role of ['reference','result']){
  const f=await setup(['SA516-70','UNKNOWN'],role),before=structuredClone(f.sheet.cells);
  await f.preview({mode:'new',name:'모델'});
  const request=f.requests.find(r=>r.url==='/operation-jobs').body;
  assert.equal(request.model_spec_column_id,null);
  assert.deepEqual(request.operation.column_ids,[f.work.columns[0].column_id]);
  assert.deepEqual(f.sheet.cells,before);
  await f.h.messages.command('적용');
  assert.deepEqual(f.sheet.cells[0],['id','모델규격명','모델','모델 종류','메모']);
  assert.deepEqual(f.sheet.cells.slice(1).map(r=>r.slice(2,4)),[['SA516-70','열처리 강종'],['','']]);
  assert.equal(f.stored.columns.find(c=>c.column_id===request.operation.column_ids[0]).role,role);
  assert(f.requests.some(r=>r.body.status==='APPLIED'));
 }
});
