const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
const noop=()=>{};
async function setup({count=4,targetCount=count}={}){
 const h=createDOM(),host=createInvestigationHost();
 const rows=Array.from({length:count},(_,i)=>[i+1,i%2?'B':'A',i%3?'KR':'CN',i%2?'N':'Y','old','memo','down']);
 const f=host.workspace(['id','회사','국가','판정','결과','메모','후속'],rows);
 let stored={...f.work,workspace_id:'work',row_count:count,target:{...f.target,row_count:targetCount}},busy=false,controller,failSave=false,job;
 h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
 h.window.workspaceStore={current:async()=>stored,save:async work=>{if(failSave)throw Error('저장 실패');stored=structuredClone(work);}};
 h.window.createMappingEditor=()=>({reset(){},get:()=>[],set(){},catalog(){},bind(){}});
 h.window.createSimilarityController=()=>({reset(){},show(){},busy(){}});
 const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url==='/operation-jobs'){job={source:body};return job;}
  if(url.includes('/preview'))return {headers:['지정값'],changed_count:body.rows.length,rows:body.rows.map(row=>({...row,values:[job.source.operation.assigned_value]}))};
  return job;
 }};
 ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js',
 'operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js',
 'workspace/result_dependencies.js','workspace/workspace.js'].forEach(h.load);
 const messages=[];
 controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
 setBusy:value=>{busy=value;controller?.setBusy(value);},complete:message=>messages.push(message),enterConversation:noop,
 beforeWorkspaceChange:target=>{if(!target)throw Error('기존 조사에 연결됨');},
 newInvestigation:async()=>{if(h.rejectNew)throw Error('새 조사 연결 실패');messages.push('새 조사 생성');controller.reset();}});
 const node=id=>h.document.getElementById(id);
 await node('work-restore').emit('click');
 const ids=Object.fromEntries(f.work.columns.map(c=>[c.header,c.column_id]));
 const change=(mode,header='判定',value='Y',operator='equals',expected)=>controller.changeScope({mode,condition:mode==='clear'?null:{column_id:ids[header],operator,value}},expected);
 async function apply(source,value='done',destination='결과',scope='current'){
  await controller.configure({kind:'set',condition_scope:scope,column_ids:[ids[source]],assigned_value:value,rules:[],delimiter:null,
   condition:{column_id:ids[source],operator:'not_blank',value:''},destination_column_id:ids[destination]});
  await controller.previewOperation();
  if(h.action('적용'))await h.messages.command('적용');
 }
 return {...f,h,host,controller,node,ids,change,apply,messages,get stored(){return stored;},set failSave(v){failSave=v;}};
}
test('scope include/exclude preserve ordered set semantics, row IDs and current/all operation behavior without cell writes',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells);
 assert.match(await f.change('replace','판정','Y'),/2행/);
 assert.match(await f.change('include','회사','B'),/4행/);
 assert.match(await f.change('exclude','국가','CN'),/2행/);
 assert.match(await f.change('include','회사','A'),/3행/);
 assert.deepEqual(f.sheet.cells,before);assert.equal(f.stored.row_filter.steps.length,3);
 await f.apply('회사','current');
 assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[4]),['current','current','current','old']);
 const filter=structuredClone(f.stored.row_filter);
 await f.apply('회사','all','결과','all');assert(f.sheet.cells.slice(1).every(row=>row[4]==='all'));
 assert.deepEqual(f.stored.row_filter,filter);
 await f.apply('회사','again');assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[4]),['again','again','again','all']);
});
test('empty scope can be expanded again; invalid, deleted or stale conditions and failed saves never widen it',async()=>{
 const f=await setup();await f.change('replace','회사','MISSING');
 assert.equal((await f.controller.context()).sample_rows.length,0);
 await f.change('include','회사','B');const before=structuredClone(f.stored.row_filter);
 await assert.rejects(()=>f.change('exclude','회사','', 'equals'),/비교할 값/);
 await assert.rejects(()=>f.change('include','missing','A'),/조건 열/);
 await assert.rejects(()=>f.change('include','회사','A','equals',{workspace_id:'wrong',expected_filter:before}),/작업표나 범위/);
 await assert.rejects(()=>f.change('include','회사','A','equals',{workspace_id:'work',expected_filter:null}),/작업표나 범위/);
 f.failSave=true;await assert.rejects(()=>f.change('include','회사','A'),/저장 실패/);f.failSave=false;
 assert.deepEqual(f.stored.row_filter,before);assert.deepEqual(JSON.parse(JSON.stringify((await f.controller.context()).row_filter)),before);
 await f.apply('회사');assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[4]),['old','done','old','done']);
});
test('include searches the whole table while retaining the old bounded selection after sort and restore',async()=>{
 const f=await setup({targetCount:1});await f.change('replace','회사','A');
 assert.match(await f.change('include','회사','B'),/3행/);
 assert.deepEqual(Array.from(f.stored.row_filter.base_ids),[1]);
 f.sheet.cells.splice(1,4,...f.sheet.cells.slice(1).reverse());
 await f.node('work-restore').emit('click');await f.apply('회사');
 assert.deepEqual(f.sheet.cells.slice(1).map(row=>[row[0],row[4]]),[[4,'done'],[3,'old'],[2,'done'],[1,'done']]);
});
test('combined scope can update its own predicate column across 10,002 rows without losing later matches',async()=>{
 const f=await setup({count:10002});await f.change('replace','판정','Y');await f.change('include','회사','B');
 await f.change('exclude','국가','CN');await f.apply('회사','N','판정');
 assert.equal(f.sheet.cells[10001][3],'N');assert.equal(f.sheet.cells[10002][3],'N');
 assert.equal(f.sheet.cells[1][3],'Y');assert.doesNotMatch(f.messages.at(-1),/일부|실패/);
});
test('only dependent outputs need review; unrelated notes, outside rows, rename and sorting do not invalidate',async()=>{
 const f=await setup();await f.change('replace','판정','Y');await f.apply('회사');
 await f.apply('결과','downstream','후속');
 assert.equal(f.stored.result_dependencies.length,2);assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
 f.sheet.cells[1][5]='unrelated note';f.sheet.cells[2][1]='unselected company';
 f.host.moveColumn(f.sheet,1,2);f.table.columns.items[2].name='회사 새 이름';
 f.sheet.cells.splice(1,4,...f.sheet.cells.slice(1).reverse());
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
 f.sheet.cells.find(row=>row[0]===1)[2]='changed input';
 const before=structuredClone(f.sheet.cells),context=await f.controller.context();
 assert.deepEqual(new Set(context.review_required_column_ids),new Set([f.ids['결과'],f.ids['후속']]));
 assert.deepEqual(f.sheet.cells,before);assert.match(f.h.chatText(),/재검토|다시 확인/);
 await f.node('work-restore').emit('click');assert.equal((await f.controller.context()).review_required_column_ids.length,2);
});
test('manual selection edits and scope changes invalidate filtered results but leave whole-table results valid',async()=>{
 const f=await setup();await f.change('replace','판정','Y');await f.apply('회사');
 await f.apply('국가','all','후속','all');
 f.sheet.cells[1][3]='N';let context=await f.controller.context();
 assert.deepEqual(Array.from(context.review_required_column_ids),[f.ids['결과']]);
 const before=structuredClone(f.sheet.cells);await f.change('include','회사','B');
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[f.ids['결과']]);assert.deepEqual(f.sheet.cells,before);
});
test('reprocessing clears the covered output only, including unchanged values, while downstream results require their own reprocessing',async()=>{
 const f=await setup();await f.change('replace','판정','Y');await f.apply('회사');await f.apply('결과','downstream','후속');
 f.sheet.cells[1][1]='changed';await f.controller.context();
 await f.apply('회사');
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[f.ids['후속']]);
 await f.apply('결과','downstream','후속');assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
});
test('formula dependencies use raw numeric inputs and ignore sort; changed inputs invalidate the stored output',async()=>{
 const f=await setup(),deps=f.h.window.resultDependencies;
 f.sheet.cells[1][1]=0.1234;
 const work={...f.stored},selection={row_start:1,row_count:4,input_columns:[{column_id:f.ids['회사']}]};
 const record=await deps.formula(work,selection);record.output_ids=[f.ids['결과']];deps.register(work,record);
 f.sheet.cells.splice(1,4,...f.sheet.cells.slice(1).reverse());await deps.reconcile(work);assert.deepEqual(Array.from(deps.required(work)),[]);
 f.sheet.cells.find(row=>row[0]===1)[1]=0.1235;await deps.reconcile(work);assert.deepEqual(Array.from(deps.required(work)),[f.ids['결과']]);
});
test('compound-filter preview refuses later predicate edits and preserves all manual values',async()=>{
 const f=await setup();await f.change('replace','판정','Y');await f.change('include','회사','B');await f.change('exclude','국가','CN');
 await f.controller.configure({kind:'set',column_ids:[f.ids['회사']],assigned_value:'write',condition_scope:'current',rules:[],delimiter:null,
 condition:{column_id:f.ids['회사'],operator:'not_blank',value:''},destination_column_id:f.ids['결과']});
 await f.controller.previewOperation();f.sheet.cells[1][2]='KR';const before=structuredClone(f.sheet.cells);
 await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);assert.match(f.messages.at(-1),/바뀌/);
});
test('partial reprocessing never clears stale results in untouched rows; a whole-table rewrite does',async()=>{
 const f=await setup();await f.apply('회사');f.sheet.cells[1][1]='changed';await f.controller.context();
 await f.change('replace','판정','Y');await f.apply('회사','partial');
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[f.ids['결과']]);
 await f.apply('회사','full','결과','all');assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[]);
});
test('new matching rows and deleted input columns mark the associated results for review without writes',async()=>{
 const f=await setup();await f.change('replace','판정','Y');await f.apply('회사');
 f.sheet.cells.push([5,'A','KR','Y','manual','note','down']);f.table.count++;
 const before=structuredClone(f.sheet.cells);await f.controller.context();assert.match(f.h.chatText(),/재검토|다시 확인/);assert.deepEqual(f.sheet.cells,before);
 const g=await setup();await g.apply('회사');g.table.columns.items.splice(1,1);g.sheet.cells.forEach(row=>row.splice(1,1));
 assert.deepEqual(Array.from((await g.controller.context()).review_required_column_ids),[g.ids['결과']]);
});
test('dependency preparation failure stops before writing cells',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells);f.h.window.crypto={};
 await f.apply('회사');assert.deepEqual(f.sheet.cells,before);assert.match(f.node('work-status').textContent,/결과 변경 확인 기능/);
});
test('partial formula output cannot clear an older whole-column review flag',async()=>{
 const f=await setup();await f.apply('회사');f.sheet.cells[1][1]='changed';await f.controller.context();
 f.sheet.cells[1][4]='';
 const selection={workspace_id:'work',worksheet_id:f.work.worksheet_id,table_id:f.work.table_id,row_start:1,row_count:4,
 input_columns:[{column_id:f.ids['회사']} ]};
 await f.controller.prepareFormulaOutput({plan:{actions:[{target_range:'E2',output_label:'결과'}]}},selection);
 f.sheet.cells[1][4]='formula result';
 await f.controller.formulaResult({targets:[{row_start:1,row_count:1,column_start:4,column_count:1}]},selection,[f.ids['결과']]);
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[f.ids['결과']]);
});
test('clear scope restores the whole table even when the saved target was a smaller row range',async()=>{
 const f=await setup({targetCount:1});assert.match(await f.change('clear'),/4행/);
 assert.equal(f.stored.target.row_count,4);await f.apply('회사');assert(f.sheet.cells.slice(1).every(row=>row[4]==='done'));
});
test('model advice uses the same combined range without reading excluded rows into its selected examples',async()=>{
 const host=createInvestigationHost();host.load('recommendation/recommendation_sheet.js');
 const f=host.workspace(['id','신고품명','거래품명','모델'],[[1,'A','CN','Y'],[2,'B','KR','N'],[3,'A','KR','Y'],[4,'B','CN','N']]);
 f.work.columns.forEach((c,i)=>c.role=['declared_name','trade_name','model_spec'][i]);
 const ids=f.work.columns.map(c=>c.column_id);
 f.work.row_filter={base:{column_id:ids[2],operator:'equals',value:'Y'},base_ids:null,steps:[
  {mode:'include',condition:{column_id:ids[0],operator:'equals',value:'B'}},{mode:'exclude',condition:{column_id:ids[1],operator:'equals',value:'CN'}}]};
 const info=await host.window.workspaceTable.layout(host.context,f.work);
 const result=await host.window.recommendationSheet.readModelAdvice(f.work,{...f.target,stamp:info.stamp},ids,noop,noop);
 assert.equal(result.selection.total_rows,2);assert(result.rows.every(row=>row.values[1]==='KR'));
});

test('input changes report affected outputs in chat without persistent warning panels',async()=>{
 const f=await setup();await f.apply('회사','1차완료','결과','all');await f.apply('결과','2차완료','후속','all');
 f.sheet.cells[1][1]='changed input';const before=structuredClone(f.sheet.cells);await f.controller.context();
 assert.match(f.h.chatText(),/결과, 후속/);assert.deepEqual(f.sheet.cells,before);assert.equal(f.node('work-review-warning'),null);
});

test('one formula run tracks only actual earlier output references, including ranges and quoted sheet names',async()=>{
 const f=await setup(),deps=f.h.window.resultDependencies,work={...f.stored};
 const selection={row_start:1,row_count:4,sheet_name:'조사',input_columns:[{column_id:f.ids['회사']}]};
 const baseline=await deps.formula(work,selection),ids=[f.ids['결과'],f.ids['후속'],f.ids['메모']];
 const records=await deps.formulaResults(work,baseline,{actions:[{formula:'=B2'},{formula:"=SUM('조사'!$E2:E2)"},{formula:'=B2&"E2"'}]},
 {targets:[4,6,5].map(column_start=>({row_start:1,row_count:4,column_start}))},selection,ids);
 records.forEach(record=>deps.register(work,record));
 const before=structuredClone(f.sheet.cells);f.sheet.cells[1][4]='manual correction';
 await deps.reconcile(work);assert.deepEqual(Array.from(deps.required(work)),[f.ids['후속']]);
 assert.equal(f.sheet.cells[1][4],'manual correction');assert.deepEqual(f.sheet.cells[2],before[2]);
 assert.equal(deps.referencesOutput('=SUM(D:E)',4,'조사'),true);
 assert.equal(deps.referencesOutput('=Other!E2',4,'조사'),false);
 assert.equal(deps.referencesOutput('="E2"',4,'조사'),false);
});
test('final result record survives manual panels and disappears when recorded values change',async()=>{
 const f=await setup();await f.apply('회사');await f.controller.context();
 await f.controller.recordFinal();await f.h.messages.command('적용');
 assert(f.stored.finalized);assert.match(f.h.chatText(),/4행/);
 await f.controller.context();assert(f.stored.finalized);
 f.sheet.cells[1][4]='manual';await f.controller.context();assert.equal(f.stored.finalized,null);
});

test('reset for a new investigation keeps the previous worksheet and saved workspace',async()=>{
 const f=await setup(),before=structuredClone(f.sheet.cells),savedId=f.stored.workspace_id;
 f.controller.reset();assert.equal(f.controller.referenceTarget(),null);assert.equal(f.stored.workspace_id,savedId);assert.deepEqual(f.sheet.cells,before);
});

test('editing an earlier formula output during the completion acknowledgement marks its downstream result for review',async()=>{
 const f=await setup();f.sheet.cells[1][4]='';f.sheet.cells[1][6]='';
 const selection={workspace_id:'work',worksheet_id:f.work.worksheet_id,sheet_name:'조사',table_id:f.work.table_id,row_start:1,row_count:4,
 input_columns:[{column_id:f.ids['회사']}]};
 await f.controller.prepareFormulaOutput({plan:{actions:[{target_range:'E2',formula:'=B2',output_label:'결과'},
  {target_range:'G2',formula:'=E2',output_label:'후속'}]}},selection);
 f.sheet.cells[1][4]='first';f.sheet.cells[1][6]='second';
 const result={targets:[4,6].map(column_start=>({row_start:1,row_count:1,column_start,column_count:1}))};
 const ids=await f.controller.formulaResultColumns(result,selection);
 f.sheet.cells[1][4]='user edit during ack';await f.controller.formulaResult(result,selection,ids);
 assert.deepEqual(Array.from((await f.controller.context()).review_required_column_ids),[f.ids['후속']]);
 assert.equal(f.sheet.cells[1][4],'user edit during ack');
});
