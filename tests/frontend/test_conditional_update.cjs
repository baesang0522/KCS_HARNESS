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
        if (h.beforeResponse) await h.beforeResponse(url,body);
        if(url==='/operation-jobs'){job={source:body};return job;}
        if(url.includes('/preview') && job.source.operation.kind==='preprocess')return {headers:['정제'],changed_count:body.rows.filter(r=>r.values[0]!==r.values[0].trim().replace(/\s+/g,' ')).length,rows:body.rows.map(r=>({...r,values:[r.values[0].trim().replace(/\s+/g,' ')]}))};
        if(url.includes('/preview'))return {headers:['지정값'],changed_count:body.rows.length,
            rows:body.rows.map(r=>({...r,values:[job.source.operation.assigned_value]}))};
        return job;
    }};
    ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','operations/operations_ui.js',
        'operations/operation_jobs.js','operations/operations.js','formula/workspace_formula.js','workspace/workspace_ui.js','workspace/result_dependencies.js','workspace/workspace_actions.js','workspace/workspace.js'].forEach(h.load);
    controller=h.window.createWorkspaceController({messages:h.messages,api,getConversationId:()=> 'conversation',isBusy:()=>busy,
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
    assert.equal(f.node('work-management'),null);
    assert.equal(f.node('op-settings'),null);assert.equal(f.node('op-finalize'),null);
    assert.equal(f.node('op-new-placement'),null);assert.equal(f.node('op-result'),null);
    assert.match(f.h.chatText(),/AB-12/);
    assert.match(f.h.chatText(),/2행 중 2행/);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.row_count,3);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.row_filter,null);
    assert.equal(f.requests.find(r=>r.url==='/operation-jobs').body.operation.condition_scope,'all');
    await f.h.messages.command('적용');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','=1+1','재확인']);
    assert.equal(f.table.columns.items.length,3);
    assert.equal(f.getStored().row_filter.value,'old','one request must not change the persisted analysis filter');
    // Returning to normal operations must restore settings and management.
    await f.controller.configure({kind:'replace',column_ids:f.operation.column_ids,rules:[],delimiter:null,find:'A',replacement:'B'});
    assert.equal(f.node('work-management'),null);assert.equal(f.node('op-condition'),null);
    assert.equal(f.node('op-settings'),null);
});
test('conditional edits reuse current values after column moves, sorting and repeated manual edits',async()=>{
    const f=await fixture();f.host.moveColumn(f.sheet,2,1);f.table.columns.items[1].name='직접 고친 메모';
    f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse());
    f.sheet.cells[1][1]='edited';
    await f.controller.configure(f.operation);await f.controller.previewOperation();
    assert.match(f.h.chatText(),/직접 고친 메모/);
    assert.match(f.h.chatText(),/edited/);
    await f.h.messages.command('적용');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>[r[0],r[1]]),[[3,'재확인'],[2,'=1+1'],[1,'재확인']]);
    f.sheet.cells[3][1]='user changed again';
    await f.controller.configure({...f.operation,assigned_value:''});await f.controller.previewOperation();
    await f.h.messages.command('적용');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[1]),['','=1+1','']);
});
test('changed conditions, target values or sorting after preview cannot silently overwrite cells',async()=>{
    for(const mutate of [f=>f.sheet.cells[1][2]='new manual value',f=>f.sheet.cells[2][1]='AB-12 now matches',
        f=>f.sheet.cells[1][1]='no longer matches',f=>f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse())]) {
        const f=await fixture();await f.controller.configure(f.operation);await f.controller.previewOperation();mutate(f);
        const before=structuredClone(f.sheet.cells);await f.h.messages.command('적용');
        assert.deepEqual(f.sheet.cells,before);assert.match(f.completed.at(-1),/바뀌|변경/);
    }
});
test('refresh preview rereads manual edits; same-column conditions can change all captured matches',async()=>{
    const f=await fixture();await f.controller.configure(f.operation);await f.controller.previewOperation();
    f.sheet.cells[1][2]='manual after preview';
    await f.controller.previewOperation();assert.match(f.h.chatText(),/manual after preview/);
    assert.equal(f.node('op-settings'),null);
    await f.h.messages.command('적용');assert.equal(f.sheet.cells[1][2],'재확인');
    await f.controller.configure({...f.operation,destination_column_id:f.operation.column_ids[0],assigned_value:'DONE'});
    await f.controller.previewOperation();await f.h.messages.command('적용');
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
        assert.deepEqual(f.sheet.cells,before);assert.equal(!f.h.action('적용'),true);
        assert.match(f.completed.at(-1),mode==='missing'?/조건에 맞는 행이 없습니다/:mode==='formula'?/수식 셀/:/변경이 없어/);
    }
});
test('3092 current rows are checked despite a one-row cached target',async()=>{
    const f=await fixture(Array.from({length:3092},(_,i)=>[i+1,i%2?'OTHER':'AB-12','keep']));
    await f.controller.configure(f.operation);await f.controller.previewOperation();
    assert.match(f.h.chatText(),/1,546행 중 1,546행/);
    await f.h.messages.command('적용');
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='재확인').length,1546);
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='keep').length,1546);
});

test('current scope intersects the existing row range, existing filter and new condition; all bypasses only for that request',async()=>{
    const rows=[[1,'AB-12 ONE','old'],[2,'AB-12 TWO','keep'],[3,'OTHER','old'],[4,'AB-12 FOUR','old']];
    for(const scope of ['current','all']) {
        const f=await fixture(rows,3);f.operation.condition_scope=scope;
        await f.controller.configure(f.operation);await f.controller.previewOperation();
        assert.match(f.h.chatText(),scope==='current'?/작업 범위/:/작업 범위/);
        const job=f.requests.find(r=>r.url==='/operation-jobs').body;
        assert.equal(job.row_count,scope==='current'?3:4);
        assert.equal(job.row_filter?.value,scope==='current'?'old':undefined);
        await f.h.messages.command('적용');
        assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),scope==='current'?['재확인','keep','old','old']:['재확인','재확인','old','재확인']);
        assert.equal(f.getStored().row_filter.value,'old');
        assert.equal(f.getStored().target.row_count,3,'explicit whole-table request must preserve the saved current range');
        if(scope==='all') {
            f.sheet.cells[1][2]='old';f.sheet.cells[4][2]='old';
            await f.controller.configure({...f.operation,condition_scope:'current',assigned_value:'후속'});
            await f.controller.previewOperation();await f.h.messages.command('적용');
            assert.equal(f.sheet.cells[1][2],'후속');assert.equal(f.sheet.cells[4][2],'old');
        }
    }
});
test('omitted scope keeps the current range and rereads manually changed filter values on the next request',async()=>{
    const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);delete f.operation.condition_scope;
    await f.controller.configure(f.operation);await f.controller.previewOperation();await f.h.messages.command('적용');
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','keep']);
    f.sheet.cells[2][2]='old';await f.controller.configure(f.operation);await f.controller.previewOperation();
    await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','재확인']);
});
test('changes to the inherited filter after preview reject writes, even when the new condition did not change',async()=>{
    for(const index of [1,2]) {
        const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);f.operation.condition_scope='current';
        await f.controller.configure(f.operation);await f.controller.previewOperation();
        f.sheet.cells[index][2]=index===1?'manual':'old';const before=structuredClone(f.sheet.cells);
        await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);assert.match(f.completed.at(-1),/바뀌/);
    }
});
test('current-scope writes can change the new condition column or the column shared by both conditions',async()=>{
    for(const shared of [false,true]) {
        const f=await fixture([[1,'AB-12','old'],[2,'AB-12','keep']],2);f.operation.condition_scope='current';
        if(shared){f.operation.column_ids=[f.operation.destination_column_id];f.operation.condition={column_id:f.operation.destination_column_id,operator:'contains',value:'ol'};}
        else f.operation.destination_column_id=f.operation.column_ids[0];
        await f.controller.configure(f.operation);await f.controller.previewOperation();await f.h.messages.command('적용');
        assert.equal(f.sheet.cells[1][shared?2:1],'재확인');assert.equal(f.sheet.cells[2][shared?2:1],shared?'keep':'AB-12');
        assert.doesNotMatch(f.completed.at(-1),/일부 반영|바뀌었습니다/);
    }
});
test('current scope processes beyond 10,000 rows including the last matching row',async()=>{
    const count=10002,f=await fixture(Array.from({length:count},(_,i)=>[i+1,'AB-12',i%2?'old':'keep']),count);
    f.operation.condition_scope='current';await f.controller.configure(f.operation);await f.controller.previewOperation();
    await f.h.messages.command('적용');assert.equal(f.sheet.cells[count][2],'재확인');
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='재확인').length,5001);
    assert.equal(f.sheet.cells.slice(1).filter(r=>r[2]==='keep').length,5001);
});

test('agent scope cancellation leaves the saved filter and all cells unchanged',async()=>{
    const f=await fixture(),before=structuredClone(f.sheet.cells),scope=structuredClone(f.getStored().row_filter);
    let checks=0;
    await assert.rejects(f.controller.changeScope({mode:'clear',condition:null},null,()=>{
        if(++checks===3)throw new Error('cancel scope');
    }),/cancel scope/);
    assert.deepEqual(f.getStored().row_filter,scope);assert.deepEqual(f.sheet.cells,before);
});

test('new-column chat preview creates the named result only after approval',async()=>{
 const f=await fixture([[1,' ABC  LTD ','memo'],[2,'XYZ','keep']],2);await f.controller.changeScope({mode:'clear'});
 const operation={kind:'preprocess',column_ids:f.operation.column_ids,rules:[{operation:'trim'},{operation:'collapse_whitespace'}],output:{mode:'new',name:'공급자명 정제'}};
 const before=structuredClone(f.sheet.cells);await f.controller.configure(operation);await f.controller.previewOperation();
 assert.deepEqual(f.sheet.cells,before);assert.match(f.h.chatText(),/2행 중 1행/);assert.match(f.h.chatText(),/공급자명 정제/);
 await f.h.messages.command('적용');const output=f.getStored().columns.find(c=>c.header==='공급자명 정제');assert(output,f.completed.at(-1));
 assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[output.column_index]),['ABC LTD','XYZ']);
 const source=f.getStored().columns.find(c=>c.column_id===f.operation.column_ids[0]);assert.equal(f.sheet.cells[1][source.column_index],' ABC  LTD ');
 assert.match(f.completed.at(-1),/완료했어.*새 열.*변경된 값은 1행/);
 const after=structuredClone(f.sheet.cells);await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,after);
});
test('changing destination rereads values, cancels the old preview and writes only the existing column',async()=>{
 const f=await fixture([[1,' ABC  LTD ','memo'],[2,'XYZ','keep']],2);await f.controller.changeScope({mode:'clear'});
 const operation={kind:'preprocess',column_ids:f.operation.column_ids,rules:[{operation:'trim'}]};
 await f.controller.configure(operation);await f.controller.previewOperation();const old=f.h.action('적용');
 const pending=(await f.controller.context()).pending_operation;assert.equal(pending.kind,'preprocess');
 f.sheet.cells[1][1]=' CHANGED  LTD ';await f.controller.configure({...pending,output:{mode:'existing',column_id:f.operation.column_ids[0]}});await f.controller.previewOperation();
 assert(old.disabled);await old.emit('click');assert.equal(f.sheet.cells[1][1],' CHANGED  LTD ');
 await f.h.messages.command('적용');assert.equal(f.sheet.cells[1][1],'CHANGED LTD');assert.equal(f.table.columns.items.length,3);
 assert(f.requests.some(r=>r.body.status==='CANCELLED'));assert.equal((await f.controller.context()).pending_operation,null);
});
test('chat cancel records cancellation and cannot write afterwards',async()=>{
 const f=await fixture();await f.controller.configure(f.operation);await f.controller.previewOperation();const before=structuredClone(f.sheet.cells);
 await f.h.messages.command('취소');await f.h.messages.command('적용');assert.deepEqual(f.sheet.cells,before);
 assert(f.requests.some(r=>r.body.status==='CANCELLED'));assert.equal((await f.controller.context()).pending_operation,null);
});


test('representative group writes immediately without a preview card or approval and preserves the saved scope',async()=>{
    const f=await fixture([[1,'CODE-A','old'],[2,'OTHER','old'],[3,'CODE-A','keep'],[4,'CODE-A','old']],4);
    const operation={...f.operation,condition_scope:'current',condition:{...f.operation.condition,operator:'equals',value:'CODE-A'}};
    let verified=0;
    await f.controller.configure(operation);
    await f.controller.previewOperation(true,async()=>{verified++;});
    assert.equal(verified,1);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['재확인','old','keep','재확인']);
    assert.equal(f.h.action('적용'),undefined);
    assert(!f.h.chatText().includes('변경 미리보기'));
    assert(f.requests.some(r=>r.body.status==='APPLIED'));
    assert.equal(f.getStored().row_filter.value,'old');
    assert.equal(f.table.columns.items.length,3);
});
test('automatic group propagation stops before writing if representative evidence changed or verification is unavailable',async()=>{
    for(const verify of [undefined,async()=>{throw new Error('대표 부호가 바뀌었습니다.');}]) {
        const f=await fixture([[1,'CODE-A','old']],1),before=structuredClone(f.sheet.cells);
        await f.controller.configure({...f.operation,condition_scope:'current',condition:{...f.operation.condition,operator:'equals',value:'CODE-A'}});
        await f.controller.previewOperation(true,verify);
        assert.deepEqual(f.sheet.cells,before);
        assert(!f.requests.some(r=>r.url.includes('/apply')));
        assert.match(f.completed.at(-1),/대표 부호/);
        assert.equal(f.h.action('적용'),undefined);
    }
});
test('automatic group propagation retains destination conflict checks and never retries an unconfirmed write',async()=>{
    for(const scenario of ['edited','lost_reply']) {
        const f=await fixture([[1,'CODE-A','old']],1);
        await f.controller.configure({...f.operation,condition_scope:'current',condition:{...f.operation.condition,operator:'equals',value:'CODE-A'}});
        f.h.beforeResponse=async(url,body)=>{
            if(scenario==='edited'&&body.status==='PREVIEW_READY')f.sheet.cells[1][2]='직접 수정';
            if(scenario==='lost_reply'&&body.status==='APPLIED')throw new Error('회신 유실');
        };
        await f.controller.previewOperation(true,async()=>{});
        assert.equal(f.sheet.cells[1][2],scenario==='edited'?'직접 수정':'재확인');
        assert.equal(f.requests.filter(r=>r.url.includes('/apply')).length,1);
        assert(f.requests.some(r=>r.body.status==='UNKNOWN'));
        assert.equal(f.h.action('적용'),undefined);
    }
});
test('automatic group propagation with unchanged values finishes without a write or approval',async()=>{
    const f=await fixture([[1,'CODE-A','old']],1);
    await f.controller.configure({...f.operation,assigned_value:'old',condition_scope:'current',condition:{...f.operation.condition,operator:'equals',value:'CODE-A'}});
    await f.controller.previewOperation(true,async()=>{});
    assert(f.requests.some(r=>r.body.status==='NO_CHANGE'));
    assert(!f.requests.some(r=>r.url.includes('/apply')));
    assert.equal(f.h.action('적용'),undefined);
});

test('stopping automatic grouping during final verification prevents the write',async()=>{
    const f=await fixture([[1,'CODE-A','old']],1),before=structuredClone(f.sheet.cells);
    await f.controller.configure({...f.operation,condition_scope:'current',condition:{...f.operation.condition,operator:'equals',value:'CODE-A'}});
    await f.controller.previewOperation(true,async()=>{f.controller.cancelPending();});
    assert.deepEqual(f.sheet.cells,before);
    assert(!f.requests.some(r=>r.url.includes('/apply')));
    assert.match(f.completed.at(-1),/취소/);
});
