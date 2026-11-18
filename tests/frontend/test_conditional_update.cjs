const test=require('node:test'), assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
async function fixture(rows, scopeRows = 1) {
    const h=createDOM(), host=createInvestigationHost();
    const f=host.workspace(['id','제품 설명','검토메모'],rows || [[1,'AB-12 ONE','old'],[2,'OTHER','=1+1'],[3,'AB-12 TWO','manual']]);
    // A previous task selected only one row and saved a different filter.
    let stored={...f.work,workspace_id:'work',target:{...f.target,row_count:scopeRows},
        row_filter:{column_id:f.work.columns[1].column_id,operator:'equals',value:'old'}};
    let busy=false, controller, job;const completed=[], requests=[];
    h.sandbox.Excel=host.Excel;h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
    h.window.workspaceStore={current:async()=>stored,save:async work=>{stored=structuredClone(work);}};
    h.window.sourceColumns={list:async()=>[]};
    h.window.createMappingEditor=()=>({reset(){},get:()=>[],set(){},catalog(){},bind(){}});
    h.window.createSimilarityController=()=>({reset(){},show(){},busy(){}});
    const api={newRequestId:()=> 'job',requestJson:async(url,options)=>{
        const body=JSON.parse(options.body);requests.push({url,body});
        if(url==='/operation-jobs'){job={source:body};return job;}
        if(url.includes('/preview'))return {headers:['지정값'],changed_count:body.rows.length,
            rows:body.rows.map(r=>({...r,values:[job.source.operation.assigned_value]}))};
        return job;
    }};
    ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js',
        'operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/workspace.js'].forEach(h.load);
    controller=h.window.createWorkspaceController({api,getConversationId:()=> 'conversation',isBusy:()=>busy,
        setBusy:v=>{busy=v;controller?.setBusy(v);},complete:text=>completed.push(text),enterConversation(){}});
    const node=id=>h.document.getElementById(id);
    await node('work-restore').emit('click');
    const operation={kind:'set',condition_scope:'all',column_ids:[f.work.columns[0].column_id],assigned_value:'재확인',rules:[],delimiter:null,
        condition:{column_id:f.work.columns[0].column_id,operator:'contains',value:'AB-12'},
        destination_column_id:f.work.columns[1].column_id};
    return {...f,h,host,controller,node,operation,requests,completed,getStored:()=>stored};
}
test('explicit all-scope condition previews the whole current table, hides grouping/settings, and updates only matching existing cells',async()=>{
    const f=await fixture(), before=structuredClone(f.sheet.cells);
    await f.controller.configure(f.operation);await f.controller.previewOperation();
    assert.deepEqual(f.sheet.cells,before,'preview must not write');
    assert.equal(f.node('work-management').hidden,true);
    assert.equal(f.node('op-settings').hidden,true);assert.equal(f.node('op-finalize').hidden,true);
    assert.equal(f.node('op-new-placement').hidden,true);assert.equal(f.node('op-result').hidden,false);
    assert.match(f.node('op-condition').textContent,/제품 설명.*AB-12.*검토메모.*재확인/);
    assert.match(f.node('op-summary').textContent,/2행 중 2행/);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.row_count,3);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.row_filter,null);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.operation.condition_scope,'all');
    await f.node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','=1+1','재확인']);
    assert.equal(f.table.columns.items.length,3);
    assert.equal(f.getStored().row_filter.value,'old','one request must not change the persisted analysis filter');
    // Returning to normal operations must restore settings and management.
    await f.controller.configure({kind:'replace',column_ids:f.operation.column_ids,rules:[],delimiter:null,find:'A',replacement:'B'});
    assert.equal(f.node('work-management').hidden,false);assert.equal(f.node('op-condition').hidden,true);
    assert.equal(f.node('op-settings').hidden,false);
});
test('conditional edits reuse current values after column moves, sorting and repeated manual edits',async()=>{
    const f=await fixture();f.host.moveColumn(f.sheet,2,1);f.table.columns.items[1].name='직접 고친 메모';
    f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse());
    f.sheet.cells[1][1]='edited';
    await f.controller.configure(f.operation);await f.controller.previewOperation();
    assert.match(f.node('op-condition').textContent,/직접 고친 메모/);
    assert.match(f.node('op-extraction-preview').textContent,/edited/);
    await f.node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>[r[0],r[1]]),[[3,'재확인'],[2,'=1+1'],[1,'재확인']]);
    f.sheet.cells[3][1]='user changed again';
    await f.controller.configure({...f.operation,assigned_value:''});await f.controller.previewOperation();
    await f.node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[1]),['','=1+1','']);
});
test('changed conditions, target values or sorting after preview cannot silently overwrite cells',async()=>{
    for(const mutate of [f=>f.sheet.cells[1][2]='new manual value',f=>f.sheet.cells[2][1]='AB-12 now matches',
        f=>f.sheet.cells[1][1]='no longer matches',f=>f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse())]) {
        const f=await fixture();await f.controller.configure(f.operation);await f.controller.previewOperation();mutate(f);
        const before=structuredClone(f.sheet.cells);await f.node('op-apply').emit('click');
        assert.deepEqual(f.sheet.cells,before);assert.match(f.completed.at(-1),/바뀌|변경/);
    }
});
test('refresh preview rereads manual edits; same-column conditions can change all captured matches',async()=>{
    const f=await fixture();await f.controller.configure(f.operation);await f.controller.previewOperation();
    f.sheet.cells[1][2]='manual after preview';
    await f.node('op-edit').emit('click');assert.match(f.node('op-extraction-preview').textContent,/manual after preview/);
    assert.equal(f.node('op-settings').hidden,true);
    await f.node('op-apply').emit('click');assert.equal(f.sheet.cells[1][2],'재확인');
    await f.controller.configure({...f.operation,destination_column_id:f.operation.column_ids[0],assigned_value:'DONE'});
    await f.controller.previewOperation();await f.node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[1]),['DONE','OTHER','DONE']);
});
test('no matches, no changes and selected formulas end without modifying the workbook',async()=>{
    for(const mode of ['missing','unchanged','formula']) {
        const f=await fixture();
        if(mode==='missing')f.operation.condition.value='NOT PRESENT';
        if(mode==='unchanged'){f.sheet.cells[1][2]='재확인';f.sheet.cells[3][2]='재확인';}
        if(mode==='formula')f.sheet.cells[1][2]='=1+1';
        const before=structuredClone(f.sheet.cells);
        await f.controller.configure(f.operation);await f.controller.previewOperation();
        assert.deepEqual(f.sheet.cells,before);assert.equal(f.node('op-apply').disabled,true);
        assert.match(f.completed.at(-1),mode==='missing'?/조건에 맞는 행이 없습니다/:mode==='formula'?/수식 셀/:/변경이 없어/);
    }
});
test('3092 current rows are checked despite a one-row cached target',async()=>{
    const f=await fixture(Array.from({length:3092},(_,i)=>[i+1,i%2?'OTHER':'AB-12','keep']));
    await f.controller.configure(f.operation);await f.controller.previewOperation();
    assert.match(f.node('op-summary').textContent,/1,546행 중 1,546행/);
    await f.node('op-apply').emit('click');
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='재확인').length,1546);
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='keep').length,1546);
});

test('current scope intersects the existing row range, existing filter and new condition; all bypasses only for that request',async()=>{
    const rows=[[1,'AB-12 ONE','old'],[2,'AB-12 TWO','keep'],[3,'OTHER','old'],[4,'AB-12 FOUR','old']];
    for(const scope of ['current','all']) {
        const f=await fixture(rows,3);f.operation.condition_scope=scope;
        await f.controller.configure(f.operation);await f.controller.previewOperation();
        assert.match(f.node('op-condition').textContent,scope==='current'?/현재 작업 범위 안에서/:/작업표 전체에서/);
        const job=f.requests.find(r=>r.url==='/operation-jobs').body;
        assert.equal(job.row_count,scope==='current'?3:4);
        assert.equal(job.row_filter?.value,scope==='current'?'old':undefined);
        await f.node('op-apply').emit('click');
        assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),scope==='current'?['재확인','keep','old','old']:['재확인','재확인','old','재확인']);
        assert.equal(f.getStored().row_filter.value,'old');
        assert.equal(f.getStored().target.row_count,3,'explicit whole-table request must preserve the saved current range');
        if(scope==='all') {
            f.sheet.cells[1][2]='old';f.sheet.cells[4][2]='old';
            await f.controller.configure({...f.operation,condition_scope:'current',assigned_value:'후속'});
            await f.controller.previewOperation();await f.node('op-apply').emit('click');
            assert.equal(f.sheet.cells[1][2],'후속');assert.equal(f.sheet.cells[4][2],'old');
        }
    }
});
test('omitted scope keeps the current range and rereads manually changed filter values on the next request',async()=>{
    const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);delete f.operation.condition_scope;
    await f.controller.configure(f.operation);await f.controller.previewOperation();await f.node('op-apply').emit('click');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','keep']);
    f.sheet.cells[2][2]='old';await f.controller.configure(f.operation);await f.controller.previewOperation();
    await f.node('op-apply').emit('click');assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','재확인']);
});
test('changes to the inherited filter after preview reject writes, even when the new condition did not change',async()=>{
    for(const index of [1,2]) {
        const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);f.operation.condition_scope='current';
        await f.controller.configure(f.operation);await f.controller.previewOperation();
        f.sheet.cells[index][2]=index===1?'manual':'old';const before=structuredClone(f.sheet.cells);
        await f.node('op-apply').emit('click');assert.deepEqual(f.sheet.cells,before);assert.match(f.completed.at(-1),/바뀌/);
    }
});
test('current-scope writes can change the new condition column or the column shared by both conditions',async()=>{
    for(const shared of [false,true]) {
        const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);f.operation.condition_scope='current';
        if(shared){f.operation.column_ids=[f.operation.destination_column_id];f.operation.condition={column_id:f.operation.destination_column_id,operator:'contains',value:'ol'};}
        else f.operation.destination_column_id=f.operation.column_ids[0];
        await f.controller.configure(f.operation);await f.controller.previewOperation();await f.node('op-apply').emit('click');
        assert.equal(f.sheet.cells[1][shared?2:1],'재확인');assert.equal(f.sheet.cells[2][shared?2:1],shared?'keep':'AB-12');
        assert.doesNotMatch(f.completed.at(-1),/일부 반영|바뀌었습니다/);
    }
});
test('current scope processes beyond 10,000 rows including the last matching row',async()=>{
    const count=10002,f=await fixture(Array.from({length:count},(_,i)=>[i+1,'AB-12',i%2?'old':'keep']),count);
    f.operation.condition_scope='current';await f.controller.configure(f.operation);await f.controller.previewOperation();
    await f.node('op-apply').emit('click');assert.equal(f.sheet.cells[count][2],'재확인');
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='재확인').length,5001);
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='keep').length,5001);
});
