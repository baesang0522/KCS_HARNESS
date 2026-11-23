const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
async function setup(values=['SA516 134X2500X12000','MODEL: UNKNOWN','2000X6000X134']){
 const h=createDOM(),host=createInvestigationHost(),f=host.workspace(['id','모델규격명','메모'],values.map((v,i)=>[i+1,v,'메모'+i]));
 f.work.columns[0].role='model_spec';
 let stored={...f.work,workspace_id:'work',target:f.target},busy=false,controller,job;
 const requests=[],completed=[];h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
 h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);}};
 h.window.sourceColumns={list:async()=>[]};h.window.createSimilarityController=()=>({reset(){},busy(){}});
 const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,body});
  if(url==='/operation-jobs')return job={source:body};
  if(url.includes('/preview')){
   if(h.cancelOnPreview){controller.cancelPending();throw new DOMException('중지','AbortError');}
   if(h.previewResponse)return h.previewResponse(body);
   const settings=job.source.operation.dimensions,fields=settings.fields||['thickness','width','length'];
   return {headers:fields.map(k=>({thickness:'두께',width:'폭',length:'길이'})[k]+'(mm)').concat('규격 파싱 상태'),
    summary:'품목: 철판 · 품목별 기본 순서: 두께×폭×길이 · 단위 없는 값: mm 가정',
    extracted_texts:body.rows.map(r=>r.values[0].includes('X')?r.values[0].replace('SA516 ',''):''),
    changed_count:body.rows.filter(r=>r.values[0].startsWith('SA516')).length,
    rows:body.rows.map(r=>({...r,values:fields.map(k=>r.values[0].startsWith('SA516')?({thickness:'134',width:'2500',length:'12000'})[k]:'')
      .concat(r.values[0].startsWith('SA516')?'추출 · 기본 순서·mm 가정':r.values[0].includes('X')?'확인 필요 · 두께·폭·길이 관계 확인':'미검출')}))};
  }
  return job;
 }};
 ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js','operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/result_dependencies.js','workspace/workspace_actions.js','workspace/workspace.js'].forEach(h.load);
 h.captureWorkspaceActions();
 controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
  setBusy:v=>{busy=v;controller?.setBusy(v);},complete:message=>completed.push(message),enterConversation(){}});
 await h.workspaceActions.restore();
 async function preview(dimensions={product:'철판'},output,settings={}){await controller.configure({kind:'dimensions',column_ids:[f.work.columns[0].column_id],dimensions,output,...settings});await controller.previewOperation();}
 return {...f,h,host,controller,requests,completed,preview,get stored(){return stored;}};
}
test('dimension preview includes evidence and status; approved writes are real numbers with blanks for ambiguity',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells);await f.preview();assert.deepEqual(f.sheet.cells,before);
 for(const text of ['찾은 치수 표기','두께(mm)','폭(mm)','길이(mm)','규격 파싱 상태','mm 가정','확인 필요 1행','미검출 1행']) assert(f.h.chatText().includes(text),text);
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells[0],['id','모델규격명','두께(mm)','폭(mm)','길이(mm)','규격 파싱 상태','메모']);
 assert.deepEqual(f.sheet.cells[1].slice(2,5),[134,2500,12000]);assert.equal(typeof f.sheet.cells[1][2],'number');
 assert.deepEqual(f.sheet.cells[2].slice(2,6),['','','','미검출']);assert.deepEqual(f.sheet.cells[3].slice(2,5),['','','']);
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>[r[1],r[6]]),before.slice(1).map(r=>r.slice(1)));
 assert.equal(f.stored.result_dependencies.length,1);assert.equal(f.requests.findLast(r=>r.body.status==='APPLIED').body.result_column_ids.length,4);
});
test('thickness-only output, current scope and custom location reuse existing controls',async()=>{
 const f=await setup();await f.controller.changeScope({mode:'replace',condition:{column_id:f.work.columns[0].column_id,operator:'contains',value:'SA516'}});
 await f.preview({product:'철판',fields:['thickness']},{mode:'new',anchor:f.work.columns[1].column_id,side:'after'},{condition_scope:'current'});
 assert.equal(f.requests.find(r=>r.url.includes('/preview')).body.selected_count,1);await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells[0],['id','모델규격명','메모','두께(mm)','규격 파싱 상태']);assert.equal(f.sheet.cells[1][3],134);
 assert.deepEqual(f.sheet.cells[2].slice(3),['','']);assert.deepEqual(f.sheet.cells[3].slice(3),['','']);
});
test('pending rules survive in context for chat correction and re-preview retires old result',async()=>{
 const f=await setup();await f.preview({product:'철판',order:['width','length','thickness'],unit:'cm',after:'SIZE:'});
 const context=await f.controller.context();assert.equal(context.pending_operation.dimensions.unit,'cm');assert.equal(context.pending_operation.dimensions.after,'SIZE:');
 await f.preview({product:'철판',fields:['thickness'],unit:'mm'});
 assert(f.requests.some(r=>r.body.status==='CANCELLED'));assert.equal(f.sheet.cells[0].length,3);
 await f.h.messages.command('적용');assert.equal(f.sheet.cells[0].length,5);
});
test('manual edits, cancellation and existing-output requests cannot silently overwrite inputs',async()=>{
 const f=await setup();await f.preview();f.sheet.cells[1][1]='manual';const before=structuredClone(f.sheet.cells);await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);
 const g=await setup();await g.preview();await g.h.messages.command('취소');assert.equal(g.sheet.cells[0].length,3);
 const k=await setup();await assert.rejects(()=>k.preview({product:'철판'},{mode:'existing',column_id:k.work.columns[1].column_id}),/치수 항목 하나/);
 const c=await setup();c.h.cancelOnPreview=true;await c.preview();assert.equal(c.sheet.cells[0].length,3);assert(c.requests.some(r=>r.body.status==='CANCELLED'));
});

test('conditional dimensions use full table, keep current filter and preserve unmatched existing values',async()=>{
 const f=await setup(['SA516 134X2500X12000','SA516 134X2500X12000','SA516 134X2500X12000']);
 const resultId=f.work.columns[1].column_id;
 await f.controller.changeScope({mode:'replace',condition:{column_id:resultId,operator:'equals',value:'메모0'}});
 const filter=structuredClone(f.stored.row_filter);
 // The saved filter must not truncate a full-table dimension request.
 await f.preview({product:'철판',fields:['thickness']},{mode:'existing',column_id:resultId},
  {condition:{column_id:f.work.columns[0].column_id,operator:'contains',value:'SA516'}});
 assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.row_filter,null);
 assert.equal(f.requests.find(r=>r.url.includes('/preview')).body.selected_count,3);
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),[134,134,134]);
 assert.equal(f.requests.findLast(r=>r.body.status==='APPLIED').body.result_column_ids[0],resultId);
 assert.deepEqual(f.stored.row_filter,filter);
 assert.equal(f.sheet.cells[0].length,3);
});
test('condition on another column selects sparse rows and existing numbers survive verification',async()=>{
 const f=await setup(['SA516 134X2500X12000','MODEL: UNKNOWN','SA516 134X2500X12000']);
 const resultId=f.work.columns[1].column_id;
 await f.preview({product:'철판',fields:['thickness']},{mode:'existing',column_id:resultId},
  {condition:{column_id:f.work.columns[0].column_id,operator:'contains',value:'SA516'}});
 await f.h.messages.command('적용');
 assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),[134,'메모1',134]);
 assert.equal(f.requests.findLast(r=>r.body.status==='APPLIED').body.result_column_ids[0],resultId);
 assert(f.h.chatText().includes('상태 정보'));
});
test('dimension condition column is sent for server validation without modifying saved scope',async()=>{
 const f=await setup(['SA516 134X2500X12000','SA516 134X2500X12000','SA516 134X2500X12000']);
 await f.preview({product:'철판',fields:['thickness']},undefined,
  {condition:{column_id:f.work.columns[1].column_id,operator:'equals',value:'메모2'}});
 const rows=f.requests.find(r=>r.url.includes('/preview')).body.rows;
 assert.equal(rows.length,1);assert.equal(rows[0].excel_row,4);assert.equal(rows[0].values[1],'메모2');
 await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[3][2],134);assert.equal(f.sheet.cells[1][2],'');
});
test('invalid text dimension cannot be written into a new or existing numeric result',async()=>{
 for(const existing of [false,true]){
  const f=await setup(['SA516 134X2500X12000']);
  f.h.previewResponse=body=>({headers:['두께(mm)','규격 파싱 상태'],summary:'철판',extracted_texts:['T W'],changed_count:1,
    rows:body.rows.map(r=>({...r,values:['W','추출']}))});
  const before=structuredClone(f.sheet.cells);
  await f.preview({product:'철판',fields:['thickness']},existing?{mode:'existing',column_id:f.work.columns[1].column_id}:undefined);
  await f.h.messages.command('적용');
  assert.deepEqual(f.sheet.cells,before);
  assert(!f.requests.some(r=>r.url.includes('/apply')));
  assert(!f.requests.some(r=>r.body.status==='APPLIED'));
 }
});
test('existing result edits after preview stop dimension overwrites',async()=>{
 const f=await setup(['SA516 134X2500X12000']);
 await f.preview({product:'철판',fields:['thickness']},{mode:'existing',column_id:f.work.columns[1].column_id});
 f.sheet.cells[1][2]='수정';await f.h.messages.command('적용');
 assert.equal(f.sheet.cells[1][2],'수정');assert(!f.requests.some(r=>r.body.status==='APPLIED'));
});

test('3036 rows are updated across write batches without converting results back to text',async()=>{
 const f=await setup(Array.from({length:3036},()=> 'SA516 134X2500X12000'));
 await f.preview({product:'철판',fields:['thickness']},{mode:'existing',column_id:f.work.columns[1].column_id});
 assert.equal(f.requests.find(r=>r.url.includes('/preview')).body.selected_count,3036);
 await f.h.messages.command('적용');
 assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]===134).length,3036);
 assert(f.requests.some(r=>r.body.status==='APPLIED'));
});
