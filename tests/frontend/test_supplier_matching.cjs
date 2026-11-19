const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
async function setup(values=['MATCH','LOW','MATCH','BORDER','']){
 const h=createDOM(),host=createInvestigationHost(),f=host.workspace(['id','해외거래처','기존그룹'],values.map((v,i)=>[i+1,v,'기존'+i]));
 let stored={...f.work,workspace_id:'work',target:f.target},busy=false,controller,job;
 const requests=[],completed=[];h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
 h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);}};
 h.window.sourceColumns={list:async()=>[]};h.window.createSimilarityController=()=>({reset(){},busy(){}});
 const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url==='/operation-jobs')return job={source:body,supplier_references:[{group:'앞',company_name:'FIRST'},{group:'뒤',company_name:'LAST'}]};
  if(url.includes('/preview')){
   if(h.cancelOnPreview){controller.cancelPending();throw new DOMException('중지','AbortError');}
   return {headers:['거래처 그룹','유사도 점수'],changed_count:body.rows.length,rows:body.rows.map(r=>({...r,values:r.values[0]==='LOW'?(['sequence','auto'].includes(job.source.operation.similarity_method)?['시퀀스 그룹','94.252874']:['','89']):!r.values[0].trim()?['','']:['뒤',r.values[0]==='BORDER'?'90':'100']}))};
  }
  return job;
 }};
 ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js','operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/result_dependencies.js','workspace/workspace.js'].forEach(h.load);
 controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
  setBusy:v=>{busy=v;controller?.setBusy(v);},complete:message=>completed.push(message),enterConversation(){},beforeApply:async()=>{if(h.unsavedPDF)throw Error('검토 시트에 반영하지 않은 수정');}});
 await h.document.getElementById('work-restore').emit('click');
 const operation={kind:'match_suppliers',column_ids:[f.work.columns[0].column_id]};
 async function preview(output,method="levenshtein"){await controller.configure({...operation,output,similarity_method:method});await controller.previewOperation();}
 return {...f,h,host,controller,requests,completed,preview,get stored(){return stored;}};
}
test('n:N preview deduplicates names, retains scores and applies two new columns to all corresponding rows',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells);await f.preview();
 assert.deepEqual(f.sheet.cells,before);const reads=f.requests.filter(r=>r.url.includes('/preview'));
 assert.equal(reads.length,1);assert.equal(reads[0].body.rows.length,4);assert.equal(reads[0].body.selected_count,5);
 assert.match(f.h.chatText(),/기준 거래처 2개 × 고유 거래처 3개/);assert.match(f.h.chatText(),/90 이상/);
 await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[0][2],'해외거래처 그룹');assert.equal(f.sheet.cells[0][3],'해외거래처 그룹 유사도 점수');
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r.slice(2,4)),[['뒤','100'],['','89'],['뒤','100'],['뒤','90'],['','']]);
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[1]),before.slice(1).map(r=>r[1]));
 assert.equal(f.stored.result_dependencies.length,1);
});
test('existing output changes only 90+ results and keeps lower scores and blanks untouched',async()=>{
 const f=await setup();f.sheet.cells[1][2]='';f.sheet.cells[3][2]='　';f.sheet.cells[2][2]=1234;await f.preview({mode:'existing',column_id:f.work.columns[1].column_id});
 assert.match(f.h.chatText(),/그룹이 빈 행만/);await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['뒤',1234,'뒤','기존3','기존4']);assert.equal(f.sheet.cells[0].length,3);
});
test('comparison chunks unique values, supports stop and never writes without approval',async()=>{
 const names=Array.from({length:502},(_,i)=>'COMPANY '+i),f=await setup(names.concat(names));await f.preview();
 assert.deepEqual(f.requests.filter(r=>r.url.includes('/preview')).map(r=>r.body.rows.length),[250,250,2]);
 assert.equal(f.sheet.cells[0].length,3);await f.h.messages.command('취소');assert.equal(f.sheet.cells[0].length,3);
 const g=await setup(names);g.h.cancelOnPreview=true;const before=structuredClone(g.sheet.cells);await g.preview();
 assert.deepEqual(g.sheet.cells,before);assert.equal(g.requests.filter(r=>r.url.includes('/preview')).length,1);
 assert(g.requests.some(r=>r.body.status==='CANCELLED'));assert.equal(g.controller.isProcessing(),false);
});
test('changed worksheet and unreflected PDF edits prevent approved writes',async()=>{
 const f=await setup();await f.preview();f.sheet.cells[1][1]='manual';const before=structuredClone(f.sheet.cells);
 await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);
 const g=await setup();await g.preview();g.h.unsavedPDF=true;const original=structuredClone(g.sheet.cells);
 await g.h.messages.command('적용');assert.deepEqual(g.sheet.cells,original);assert(!g.requests.some(r=>r.url.includes('/apply')));
});
test('current row scope restricts comparison and destination writes',async()=>{
 const f=await setup();f.sheet.cells[1][2]='';f.sheet.cells[3][2]='';await f.controller.changeScope({mode:'replace',condition:{column_id:f.work.columns[0].column_id,operator:'equals',value:'MATCH'}});
 await f.preview({mode:'existing',column_id:f.work.columns[1].column_id});
 const read=f.requests.find(r=>r.url.includes('/preview'));assert.equal(read.body.rows.length,1);assert.equal(read.body.selected_count,2);
 await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['뒤','기존1','뒤','기존3','기존4']);
});

test('sequence follow-up reuses the group-score pair and skips classified rows before deduplication',async()=>{
 const f=await setup();await f.preview();await f.h.messages.command('적용');
 f.sheet.cells[1][3]=91.111111;f.sheet.cells[2][2]='　';f.sheet.cells[2][3]='88.888889';
 const before=structuredClone(f.sheet.cells),start=f.requests.length;
 await f.preview(undefined,'sequence');
 const requests=f.requests.slice(start),job=requests.find(r=>r.url==='/operation-jobs').body;
 assert.equal(job.operation.similarity_method,'sequence');assert.equal(job.operation.output.mode,'existing');
 assert(job.operation.output.score_column_id);assert.equal(job.operation.condition.operator,'blank');
 const rows=requests.filter(r=>r.url.includes('/preview')).flatMap(r=>r.body.rows);
 assert.deepEqual(rows.map(r=>r.values[0]),['LOW','']);assert.match(f.h.chatText(),/SequenceMatcher/);
 assert.deepEqual(f.sheet.cells,before);await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[0].length,before[0].length);assert.deepEqual(f.sheet.cells[2].slice(2,4),['시퀀스 그룹','94.252874']);
 for(const i of [1,3,4,5])assert.deepEqual(f.sheet.cells[i],before[i]);
 assert.equal(typeof f.sheet.cells[1][3],'number');assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
 const status=f.requests.filter(r=>r.body.status==='APPLIED').at(-1);assert.equal(status.body.result_column_ids.length,2);
});
test('all-classified scope makes no comparison or write, and leaves original scores untouched',async()=>{
 const f=await setup(['MATCH','BORDER']);await f.preview();await f.h.messages.command('적용');
 const before=structuredClone(f.sheet.cells),start=f.requests.length;await f.preview(undefined,'sequence');
 assert(!f.requests.slice(start).some(r=>r.url.includes('/preview')));assert.deepEqual(f.sheet.cells,before);
 assert.match(f.completed.at(-1),/그룹이 빈 행이 없어/);assert(f.requests.slice(start).some(r=>r.body.status==='NO_CHANGE'));
});
test('same name in classified and blank rows only fills the blank row; non-adjacent score columns work',async()=>{
 const f=await setup(['LOW','LOW','MATCH']);await f.preview();await f.h.messages.command('적용');
 f.sheet.cells[1][2]='수동 그룹';f.sheet.cells[1][3]=96;
 f.host.moveColumn(f.sheet,3,4);const before=structuredClone(f.sheet.cells);await f.preview(undefined,'sequence');
 await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells[1],before[1]);assert.deepEqual(f.sheet.cells[3],before[3]);
 assert.equal(f.sheet.cells[2][2],'시퀀스 그룹');assert.equal(f.sheet.cells[2][4],'94.252874');assert.equal(f.sheet.cells[2][3],before[2][3]);
});
test('manual score or group edits after the follow-up preview block both writes',async()=>{
 for(const [column,value] of [[2,'수동 그룹'],[3,'수동 점수']]){
  const f=await setup();await f.preview();await f.h.messages.command('적용');await f.preview(undefined,'sequence');
  f.sheet.cells[2][column]=value;const before=structuredClone(f.sheet.cells),start=f.requests.length;
  await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);assert(!f.requests.slice(start).some(r=>r.url.includes('/apply')));
 }
});
test('both existing outputs can be scope predicates across Excel batches without losing rows',async()=>{
 const host=createInvestigationHost(),f=host.workspace(['id','회사','그룹','점수'],Array.from({length:10002},(_,i)=>[i+1,'ABC','　','80']));
 const [source,group,score]=f.work.columns.map(c=>String(c.column_id)),sheet=host.window.operationsSheet,noop=()=>{};
 f.work.row_filter={column_id:score,operator:'equals',value:'80'};
 const snapshot=await sheet.read(f.work,f.target,[source],noop,noop,[group,score],null,null,{column_id:group,operator:'blank',value:''});
 const values=snapshot.rows.map(()=>['그룹','94']);
 await sheet.write(snapshot,values,['그룹','점수'],{mode:'existing',column_id:group,score_column_id:score},noop);
 assert(f.sheet.cells.slice(1).every(row=>row[2]==='그룹'&&row[3]==='94'));
});
test('protected classified scores are not read as output targets or overwritten',async()=>{
 const f=await setup();await f.preview();await f.h.messages.command('적용');f.sheet.cells[3][3]='=1+1';
 await f.preview(undefined,'sequence');await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[3][3],'=1+1');assert.equal(f.sheet.cells[2][2],'시퀀스 그룹');
});

test('automatic matching combines both passes in one preview and one approved write',async()=>{
 const f=await setup(['MATCH','LOW','BORDER']);await f.preview(undefined,'auto');
 assert.match(f.h.chatText(),/자동 매칭/);assert.equal(f.sheet.cells[0].length,3);
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r.slice(2,4)),[['뒤','100'],['시퀀스 그룹','94.252874'],['뒤','90']]);
 assert.equal(f.requests.filter(r=>r.url.includes('/apply')).length,1);
});
test('automatic follow-up preserves the existing pair and fills only remaining blank groups',async()=>{
 const f=await setup();await f.preview();await f.h.messages.command('적용');
 const before=structuredClone(f.sheet.cells),start=f.requests.length;await f.preview(undefined,'auto');
 assert.match(f.h.chatText(),/자동 매칭/);await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[0].length,before[0].length);assert.deepEqual(f.sheet.cells[2].slice(2,4),['시퀀스 그룹','94.252874']);
 for(const i of [1,3,4,5])assert.deepEqual(f.sheet.cells[i],before[i]);
 assert.equal(f.requests.slice(start).filter(r=>r.url.includes('/apply')).length,1);
});
