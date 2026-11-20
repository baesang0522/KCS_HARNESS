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
 controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
  setBusy:v=>{busy=v;controller?.setBusy(v);},complete:message=>completed.push(message),enterConversation(){}});
 await h.document.getElementById('work-restore').emit('click');
 async function preview(dimensions={product:'철판'},output){await controller.configure({kind:'dimensions',column_ids:[f.work.columns[0].column_id],dimensions,output});await controller.previewOperation();}
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
 await f.preview({product:'철판',fields:['thickness']},{mode:'new',anchor:f.work.columns[1].column_id,side:'after'});
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
 const k=await setup();await assert.rejects(()=>k.preview({product:'철판'},{mode:'existing',column_id:k.work.columns[1].column_id}),/새 결과 열/);
 const c=await setup();c.h.cancelOnPreview=true;await c.preview();assert.equal(c.sheet.cells[0].length,3);assert(c.requests.some(r=>r.body.status==='CANCELLED'));
});
