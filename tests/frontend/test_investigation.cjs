const test=require('node:test'), assert=require('node:assert/strict');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
const noop=()=>{};
function fixture(){
    const h=createInvestigationHost();
    const f=h.workspace(['원본행','상호','선정','확정값'],[[101,' A ','Y','old-a'],[102,' B ','N','keep'],[103,' C ','Y','old-c']]);
    f.work.row_filter={column_id:f.work.columns[1].column_id,operator:'equals',value:'Y'};
    return {...f,h,api:h.window.operationsSheet};
}
const read=f=>f.api.read(f.work,f.target,[f.work.columns[0].column_id],noop,noop,f.work.columns[2].column_id);
const write=(f,s,values)=>f.api.write(s,values,['확정값'],{mode:'existing',column_id:f.work.columns[2].column_id},noop);
test('existing arbitrary column updates only disjoint matching rows and can be reused after manual editing',async()=>{
    const f=fixture(), count=f.table.columns.items.length;
    let s=await read(f);assert.deepEqual(Array.from(s.rows,r=>r.identity),[101,103]);
    await write(f,s,[['A'],['C']]);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[3]),['A','keep','C']);
    f.sheet.cells[1][3]='manual';s=await read(f);assert.equal(s.rows[0].destination,'manual');
    await write(f,s,[['reviewed A'],['reviewed C']]);
    assert.equal(f.table.columns.items.length,count);assert.equal(f.sheet.cells[2][3],'keep');
});
test('editing the condition column itself uses the captured matching rows without dropping later rows',async()=>{
    const f=fixture(), id=f.work.columns[1].column_id;
    const s=await f.api.read(f.work,f.target,[id],noop,noop,id);
    await f.api.write(s,[['N'],['N']],['선정'],{mode:'existing',column_id:id},noop);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['N','N','N']);
});
test('new result column writes to the original physical rows with blank excluded rows',async()=>{
    const f=fixture();const s=await f.api.read(f.work,f.target,[f.work.columns[0].column_id],noop,noop);
    await f.api.write(s,[['A'],['C']],['결과'],{anchor:f.work.columns[2].column_id,side:'after'},noop);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[4]),['A','','C']);
});
test('column movement, renaming and row sorting before a new preview preserve identity',async()=>{
    const f=fixture();f.h.moveColumn(f.sheet,3,1);f.table.columns.items[1].name='옮긴 확정값';
    f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse());
    const s=await read(f);assert.deepEqual(Array.from(s.rows,r=>r.identity),[103,101]);
    await write(f,s,[['C-confirmed'],['A-confirmed']]);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>[r[0],r[1]]),[[103,'C-confirmed'],[102,'keep'],[101,'A-confirmed']]);
});
test('changes after preview are rejected before any existing cell is overwritten',async()=>{
    for(const mutate of [f=>f.sheet.cells[1][3]='manual',f=>f.sheet.cells[2][2]='Y',
        f=>f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse()),f=>f.h.moveColumn(f.sheet,3,1),
        f=>{f.work.row_filter.value='N';}]) {
        const f=fixture(), s=await read(f);mutate(f);const before=structuredClone(f.sheet.cells);
        await assert.rejects(()=>write(f,s,[['A'],['C']]));assert.deepEqual(f.sheet.cells,before);
    }
});
test('empty conditions, missing/duplicate identities and formula destinations are rejected',async()=>{
    for(const mutate of [f=>f.work.row_filter.value='missing',f=>f.sheet.cells[2][0]=101,
        f=>f.sheet.cells[1][0]='',f=>f.sheet.cells[1][3]='=A1']) {
        const f=fixture();mutate(f);await assert.rejects(()=>read(f));
    }
});
test('concurrent edits between sparse write batches stop further writes and report partial output',async()=>{
    const f=fixture(),s=await read(f);let changed=false;
    f.h.beforeSync=()=>{if(!changed&&f.sheet.cells[1][3]==='A'){changed=true;f.sheet.cells[3][3]='new manual';}};
    await assert.rejects(()=>write(f,s,[['A'],['C']]),/일부 반영/);
    assert.equal(f.sheet.cells[3][3],'new manual');
});
test('source snapshot imports omitted columns by row identity after sorting, independent of edits to original',async()=>{
    const h=createInvestigationHost(),original=h.addSheet('원본',[['상호','주소','판단'],['A','서울','Y'],['B','부산','N'],['C','대전','Y']]);
    const work=await h.window.workspaceCopy.create({worksheet_id:original.id,task_type:'investigation',
        roles:[],mapping:{},reference_columns:[{source_index:0},{source_index:2}],column_count:3,column_indexes:[0,1,2],
        row_start:0,row_count:4,headers:['상호','주소','판단'],address:'A1:C4'},'조사_001',noop);
    assert.equal(work.columns.length,2);assert.equal(work.source_snapshot.columns.length,3);
    const sheet=h.sheets.find(s=>s.id===work.worksheet_id);
    sheet.cells.splice(1,3,...sheet.cells.slice(1).reverse());h.moveColumn(sheet,1,2);
    original.cells[1][1]='바뀐 주소';original.cells.splice(1,3,...original.cells.slice(1).reverse());
    work.row_filter={column_id:String(work.columns[1].column_id),operator:'equals',value:'Y'};
    const candidates=await h.window.sourceColumns.list(work);assert.equal(candidates.length,1);
    const result=await h.window.sourceColumns.append(work,String(candidates[0].column_id),noop);
    const c=result.columns[0].column_index;
    assert.deepEqual(sheet.cells.slice(1).map(r=>[r[0],r[c]]),[[4,'대전'],[3,'부산'],[2,'서울']]);
    assert(h.sheets.find(s=>s.id===work.source_snapshot.worksheet_id).protected);
    assert.deepEqual(Array.from(work.columns,c=>c.source_column_id),Array.from(work.source_snapshot.columns.filter((_,i)=>i!==1),c=>String(c.column_id)));
});
test('a deleted and recreated column is not rebound by matching header',async()=>{
    const f=fixture();const old=f.work.columns[2].column_id;
    f.table.columns.items.pop();f.sheet.cells.forEach(r=>r.pop());f.table.columns.add(null,null,'확정값');
    await assert.rejects(()=>f.api.read(f.work,f.target,[f.work.columns[0].column_id],noop,noop,old),/대상 열/);
});

test('large alternating selections use bounded batches instead of one Excel roundtrip per row',async()=>{
    const h=createInvestigationHost();
    const f=h.workspace(['id','값','판정'],Array.from({length:10000},(_,i)=>[i+1,'old',i%2?'N':'Y']));
    f.work.row_filter={column_id:f.work.columns[1].column_id,operator:'equals',value:'Y'};
    const id=f.work.columns[0].column_id;
    const s=await h.window.operationsSheet.read(f.work,f.target,[id],noop,noop,id);
    await h.window.operationsSheet.write(s,s.rows.map(()=>['new']),['값'],{mode:'existing',column_id:id},noop);
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[1]==='new').length,5000);
    assert(h.syncs<250,`too many round trips: ${h.syncs}`);
});

test('actual workspace UI saves an arbitrary condition, updates an existing column and restores the condition',async()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs');
    const h=createDOM(),host=createInvestigationHost();
    const f=host.workspace(['id','사용자 값','검토표시'],[[1,'old','OK'],[2,'keep','NO'],[3,'old','OK']]);
    const saved={...f.work,workspace_id:'work',target:f.target};let stored=saved,busy=false,controller,job,revealed=0;
    h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
    h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);}};
    h.window.sourceColumns={list:async()=>[]};
    h.window.createMappingEditor=()=>({reset(){},get:()=>[],set(){},catalog(){},bind(){}});
    h.window.createSimilarityController=()=>({reset(){},show(){},busy(){}});
    const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
        const body=JSON.parse(options.body);
        if(url==='/operation-jobs'){job={source:body};return job;}
        if(url.includes('/preview'))return {headers:['지정값'],changed_count:body.rows.length,
            rows:body.rows.map(r=>({...r,values:[job.source.operation.assigned_value]}))};
        return job;
    }};
    ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js',
        'operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/workspace.js'].forEach(h.load);
    controller=h.window.createWorkspaceController({api,getConversationId:()=> 'conversation',isBusy:()=>busy,
        showWorkspace:()=>{revealed++;},
        setBusy:v=>{busy=v;controller?.setBusy(v);},complete:noop,enterConversation:noop});
    const node=id=>h.document.getElementById(id);
    await node('work-restore').emit('click');
    node('work-filter-column').value=f.work.columns[1].column_id;
    node('work-filter-operator').value='equals';node('work-filter-value').value='OK';
    await node('work-filter-save').emit('click');
    assert.equal(stored.row_filter.value,'OK');
    node('op-kind').value='set';node('op-column').value=f.work.columns[0].column_id;
    node('op-assigned-value').value='confirmed';node('op-output-mode').value='existing';node('op-existing-column').value=f.work.columns[0].column_id;
    await node('op-preview').emit('click');
    assert.equal(node('op-result').hidden,false,node('work-status').textContent);
    assert(node('op-summary').textContent.includes('기존'));
    await node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[1]),['confirmed','keep','confirmed']);
    assert.equal(stored.columns.length,2);assert.equal(stored.target.row_count,3);
    await node('work-restore').emit('click');
    assert.equal(node('work-filter-value').value,'OK');
    await controller.openSourceColumns();
    assert.equal(revealed,1);assert.equal(node('work-panel').hidden,false);
    assert.equal(node('work-import').hidden,false);assert.equal(node('work-import-add').disabled,true);
    assert(node('work-status').textContent.includes('모두 가져왔습니다'));
});

test('source import stays disabled for an empty list after busy state changes; help launcher belongs to workspace',async()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();h.load('workspace/workspace_ui.js');
    const ui=h.window.createWorkspaceUI(),node=id=>h.document.getElementById(id);
    assert.equal(node('welcome-content').querySelector('[data-open-cleaning-help]'),null);
    assert(node('work-current').querySelector('[data-open-cleaning-help]'));
    ui.importColumns([]);ui.busy(true,false);ui.busy(false,false);
    assert.equal(node('work-import-add').disabled,true);
    ui.importColumns([{column_id:'source',header:'추가 열'}]);ui.busy(false,false);
    assert.equal(node('work-import-add').disabled,true);
    const check=node('work-import-columns').querySelector('input');check.checked=true;await check.emit('change');
    assert.equal(node('work-import-add').disabled,false);
    ui.setup();assert.equal(node('work-import').hidden,true);
});

test('company advice and model frequency selection both exclude nonmatching rows',async()=>{
    const h=createInvestigationHost();h.load('recommendation/recommendation_sheet.js');h.load('recommendation/recommendation.js');
    const f=h.workspace(['id','품명','거래품명','모델규격','선정'],[
        [1,'P','T','AB1','Y'],[2,'EXCLUDED','EXCLUDED','XX1','N'],[3,'p','t','ab1','Y'],[4,'Q','U','CD2','Y']]);
    ['declared_name','trade_name','model_spec','reference'].forEach((role,i)=>f.work.columns[i].role=role);
    f.work.row_filter={column_id:f.work.columns[3].column_id,operator:'equals',value:'Y'};
    const ids=f.work.columns.slice(0,3).map(c=>c.column_id);
    let result=await h.window.readRecommendation(f.work,ids,structuredClone(f.work),noop,noop);
    assert.deepEqual(Array.from(result.rows,r=>r.excel_row),[2,4,5]);
    assert.equal(result.row_count,3);assert.equal(result.range_row_count,4);assert.equal(result.sparse,true);
    f.work.advice_subject='model';
    result=await h.window.readRecommendation(f.work,ids,structuredClone(f.work),noop,noop);
    assert.equal(result.selection.total_rows,3);assert.equal(result.selection.total_combinations,2);
    assert.deepEqual(Array.from(result.rows,r=>[r.excel_row,r.count,r.values[2]]),[[2,2,'AB1'],[5,1,'CD2']]);
    f.work.row_filter.value='missing';
    await assert.rejects(()=>h.window.readRecommendation(f.work,ids,structuredClone(f.work),noop,noop),/조건에 맞는 행/);
});

test('model extraction suggestions receive only selected rows from the shared reader',async()=>{
    const h=createInvestigationHost();h.load('operations/extraction_suggestions.js');
    const f=h.workspace(['id','모델규격','판단'],[[1,'AB1','Y'],[2,'EXCLUDED','N'],[3,'CD2','Y']]);
    f.work.columns[0].role='model_spec';
    f.work.row_filter={column_id:f.work.columns[1].column_id,operator:'equals',value:'Y'};
    let sent;
    const api={requestJson:async(url,options)=>{sent=JSON.parse(options.body);return {sample_count:sent.values.length,suggestions:[]};}};
    await h.window.readExtractionSuggestions(f.work,f.target,[f.work.columns[0].column_id],api,noop);
    assert.deepEqual(sent.values,['AB1','CD2']);
});

test('filtered formula setup and application stop before any Excel calls',async()=>{
    const h=createInvestigationHost();h.load('formula/workspace_formula.js');const f=fixture();
    f.work.workspace_id='work';
    const formulas=h.window.createWorkspaceFormula({getWorkspace:()=>f.work,getTarget:()=>f.target,getLastFormula:()=>null});
    const selection={workspace_id:'work',worksheet_id:f.work.worksheet_id,table_id:f.work.table_id};
    await assert.rejects(()=>formulas.formulaTarget(selection,false),/조건 범위/);
    await assert.rejects(()=>formulas.validateFormulaSource(selection),/조건이 설정/);
    await assert.rejects(()=>formulas.prepareFormulaOutput({},selection),/조건이 설정/);
    assert.equal(h.syncs,0);
});

test('initial setup allows a user column without any business role',async()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();
    h.window.workspaceProfiles={investigation:{roles:[{key:'company_name',labels:['공급자명']},{key:'model_spec',labels:['모델규격']}]}};
    h.load('workspace/workspace_columns.js');h.load('workspace/workspace_ui.js');
    const ui=h.window.createWorkspaceUI();
    ui.source({sheet_name:'원본',address:'A1:B4',data_row_count:3,column_indexes:[0,1],headers:['메모','판정']},h.window.workspaceProfiles.investigation,noop);
    assert.deepEqual(Array.from(ui.mapping()),[-1,-1]);
    const check=h.document.getElementById('work-extra-columns').querySelector('input');check.checked=true;await check.emit('change');
    assert.equal(ui.extras().length,1);assert.equal(ui.extras()[0].source_index,0);
});

test('source column import preserves numeric and boolean values and number formats after sorting',async()=>{
    const h=createInvestigationHost(),original=h.addSheet('원본',[['이름','금액'],['A',123.45],['B',0],['C',true]]);
    original.formats=[[],['General','0.00'],['General','0.00'],['General','General']];
    const work=await h.window.workspaceCopy.create({worksheet_id:original.id,task_type:'investigation',
        roles:[],mapping:{},reference_columns:[{source_index:0}],column_count:2,column_indexes:[0,1],
        row_start:0,row_count:4,headers:['이름','금액'],address:'A1:B4'},'조사_002',noop);
    const sheet=h.sheets.find(s=>s.id===work.worksheet_id);sheet.cells.splice(1,3,...sheet.cells.slice(1).reverse());
    const candidates=await h.window.sourceColumns.list(work);
    const result=await h.window.sourceColumns.append(work,String(candidates[0].column_id),noop);
    const c=result.columns[0].column_index;
    assert.deepEqual(sheet.cells.slice(1).map(r=>r[c]),[true,0,123.45]);
    assert.deepEqual(sheet.formats.slice(1).map(r=>r[c]),['General','0.00','0.00']);
});

test('chat samples stop after ten matching rows without scanning the entire table',async()=>{
    const h=createInvestigationHost();
    const f=h.workspace(['id','값'],Array.from({length:10000},(_,i)=>[i+1,i%2?'no':'yes']));
    const id=f.work.columns[0].column_id;
    f.work.row_filter={column_id:id,operator:'equals',value:'yes'};
    const sample=await h.window.operationsSheet.read(f.work,f.target,[id],noop,noop,null,10);
    assert.equal(sample.rows.length,10);assert(sample.rows.every(r=>r.values[0]==='yes'));
    assert(h.syncs<8,`sample scanned too much: ${h.syncs}`);
});

async function narrowSource() {
    const h=createInvestigationHost();
    const original=h.addSheet('원본',[['금액','상호','모델'],[10,'A','AB1'],[20,'B','CD2'],[30,'C','EF3']]);
    const work=await h.window.workspaceCopy.create({worksheet_id:original.id,task_type:'investigation',roles:['model_spec'],
        mapping:{model_spec:0},reference_columns:[],column_count:1,column_indexes:[2],row_start:0,row_count:4,
        headers:['모델'],address:'원본!C1:C4'},'조사_좁은선택',noop);
    // Existing workbooks created before source column metadata was saved.
    work.source_snapshot.columns.forEach(c=>{delete c.source_column_index;delete c.source_header;});
    return {h,original,work,sheet:h.sheets.find(s=>s.id===work.worksheet_id)};
}

test('imports an initially unselected original column into an existing sorted and edited workspace',async()=>{
    const {h,original,work,sheet}=await narrowSource();
    const choices=await h.window.sourceColumns.list(work);
    assert.deepEqual(Array.from(choices,c=>c.header),['금액','상호']);
    assert(choices.every(c=>c.origin==='live'));
    sheet.cells.splice(1,3,...sheet.cells.slice(1).reverse());sheet.cells[1][1]='manually cleaned';
    const result=await h.window.sourceColumns.append(work,'live:0',noop,{original_order_confirmed:true,header:'금액'});
    assert.deepEqual(sheet.cells.slice(1).map(r=>[r[0],r[2]]),[[4,30],[3,20],[2,10]]);
    assert.equal(sheet.cells[1][1],'manually cleaned');
    work.columns.push(...result.columns);
    assert.deepEqual(Array.from(await h.window.sourceColumns.list(work),c=>c.header),['상호']);
    assert.deepEqual(original.cells[1],[10,'A','AB1']);
});

test('live import refuses missing row-order confirmation, source changes and stale header before writing',async()=>{
    for(const change of [f=>f.original.cells.reverse(), f=>f.original.cells[2][2]='modified',
        f=>f.original.cells[0][0]='renamed', f=>f.original.cells.splice(2,1)]) {
        const f=await narrowSource();change(f);const before=structuredClone(f.sheet.cells);
        await assert.rejects(()=>f.h.window.sourceColumns.append(f.work,'live:0',noop,{original_order_confirmed:true,header:'금액'}));
        assert.deepEqual(f.sheet.cells,before);
    }
    const f=await narrowSource();
    await assert.rejects(()=>f.h.window.sourceColumns.append(f.work,'live:0',noop,{header:'금액'}),/정렬·추가·삭제/);
});

test('live import UI requires an explicit original-order check and clears it on column change',async()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();h.load('workspace/workspace_ui.js');
    const ui=h.window.createWorkspaceUI(),node=id=>h.document.getElementById(id);ui.bind({});
    ui.importColumns([{column_id:'live:0',header:'금액',origin:'live'},{column_id:'live:1',header:'상호',origin:'live'}]);
    ui.busy(false,false);assert.equal(node('work-import-add').disabled,true);
    const checks=node('work-import-columns').querySelectorAll('input');
    checks[0].checked=true;await checks[0].emit('change');
    node('work-import-confirm').checked=true;await node('work-import-confirm').emit('change');
    assert.equal(node('work-import-add').disabled,false);assert.equal(ui.importSelection()[0].header,'금액');
    checks[1].checked=true;await checks[1].emit('change');
    assert.deepEqual(Array.from(ui.importSelection(),c=>c.header),['금액','상호']);
    assert.equal(node('work-import-add').disabled,true);assert.equal(ui.importPolicy().original_order_confirmed,false);
});

for (const failSecond of [false, true]) test(`multiple imports preserve row identity and saved links; second failure=${failSecond}`,async()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();
    const f=await narrowSource();let stored=f.work,busy=false,controller,failed=false;
    f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse());
    stored.row_filter={column_id:String(stored.columns[0].column_id),operator:'equals',value:'AB1'};
    const saves=[],calls=[];
    h.sandbox.Excel=f.h.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
    h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);saves.push(stored);}};
    h.window.sourceColumns={list:f.h.window.sourceColumns.list,append:async(work,id,progress,policy)=>{
        calls.push(id);
        if(failSecond && id==='live:1' && !failed){failed=true;throw Error('두 번째 열 읽기 실패');}
        return f.h.window.sourceColumns.append(work,id,progress,policy);
    }};
    h.window.createMappingEditor=()=>({reset(){},get:()=>[],set(){},catalog(){},bind(){}});
    h.window.createSimilarityController=()=>({reset(){},show(){},busy(){}});
    ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js',
        'operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/workspace.js'].forEach(h.load);
    controller=h.window.createWorkspaceController({api:{newRequestId:()=> 'job'},getConversationId:()=> 'conversation',
        isBusy:()=>busy,setBusy:v=>{busy=v;controller?.setBusy(v);},showWorkspace:noop,complete:noop,enterConversation:noop});
    const node=id=>h.document.getElementById(id);
    await node('work-restore').emit('click');await controller.openSourceColumns();
    assert.equal(node('work-scope-settings').hidden,true);assert.equal(node('work-advice-settings').hidden,true);
    assert.equal(node('op-settings').hidden,false);
    for(const check of node('work-import-columns').querySelectorAll('input')){check.checked=true;await check.emit('change');}
    node('work-import-confirm').checked=true;await node('work-import-confirm').emit('change');
    await node('work-import-add').emit('click');
    assert.deepEqual(calls,['live:0','live:1']);
    assert(saves.some(work=>work.columns.length===2 && work.columns[1].source_column_index===0),'first import link not persisted');
    if(failSecond){
        assert.equal(stored.columns.length,2);assert.match(node('work-status').textContent,/1개 열은 추가됐고.*두 번째 열/);
        const checks=node('work-import-columns').querySelectorAll('input');assert.equal(checks.length,1);
        checks[0].checked=true;await checks[0].emit('change');
        node('work-import-confirm').checked=true;await node('work-import-confirm').emit('change');
        await node('work-import-add').emit('click');
        assert.deepEqual(calls,['live:0','live:1','live:1']);
    }
    assert.equal(stored.columns.length,3,node('work-status').textContent);
    for(const [header,expected] of [['금액',[30,20,10]],['상호',['C','B','A']]]){
        const column=stored.columns.find(c=>c.header===header);
        assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[column.column_index]),expected);
        assert(node('op-column').querySelectorAll('option').some(o=>o.textContent===header));
    }
    assert.equal(stored.row_filter.value,'AB1');assert.match(node('work-operation-scope').textContent,/AB1/);
    assert.equal(node('work-scope-settings').hidden,true);assert.equal(node('work-advice-settings').hidden,true);
    assert.equal(node('work-import-add').disabled,true);
    await controller.open();
    assert.equal(node('work-scope-settings').hidden,false);assert.equal(node('work-advice-settings').hidden,false);
});
