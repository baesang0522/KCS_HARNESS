const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createHost}=require('../helpers/excel_mock.cjs');
async function setup() {
    const columns=[['declared',1,'declared_name'],['trade',2,'trade_name'],['model',3,'model_spec'],
        ['grouped',5,'result'],['replaced',6,'result'],['cleaned',25,'result']].map(([column_id,column_index,role])=>({column_id,column_index,role,header:column_id,description:''}));
    const saved={workspace_id:'workspace',worksheet_id:'sheet',table_id:'table',task_type:'model_normalization',
        source_row_column_id:'identity',sheet_name:'Sheet1',row_count:90000,columns,
        target_column_ids:['replaced'],last_result_column_ids:['replaced'],target:{row_start:1,row_count:90000}};
    const h={columns:structuredClone(columns),selection:null,status:[],configured:null};
    let handlers,selected=['replaced'];
    const ui=new Proxy({bind:x=>{handlers=x;},status:x=>h.status.push(x)},{get:(o,k)=>o[k]||(()=>{})});
    const operations={targets:()=>selected.slice(),show:(w,t,ids)=>{selected=Array.from(ids);},
        reconcile:()=>false,configure:x=>{h.configured=x;},sampleRows:async()=>[],invalidate(){},reset(){},busy(){}};
    const target=w=>({worksheet_id:'sheet',sheet_name:'Sheet1',row_start:1,row_count:90000,columns:w.columns});
    const window={createWorkspaceUI:()=>ui,createOperationJobs:()=>({}),createOperations:()=>operations,
        createSimilarityController:()=>({reset(){},busy(){}}),
        workspaceStore:{current:async()=>saved,save:async()=>{}},
        workspaceSheet:{requireExcel(){},readWorkspaceTarget:async w=>h.selection||target(w)},
        workspaceTable:{layout:async()=>({sheet:{name:'Sheet1'},body:{rowIndex:1,rowCount:90000,columnIndex:0,columnCount:30},
            columns:h.columns,identity:{column_id:'identity'}})}};
    window.errorMessages = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/services/error_messages.json'), 'utf8'));
    const sandbox={window,console,Excel:{run:async fn=>fn({})}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/formula/workspace_formula.js'),'utf8'),sandbox);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/workspace/workspace.js'),'utf8'),sandbox);
    h.controller=window.createWorkspaceController({api:{newRequestId:()=> 'id'},getConversationId:()=> 'conversation',
        isBusy:()=>false,setBusy(){},complete(){},enterConversation(){},
        onWorkspaceReady: async target => { h.reference = target; }});
    await handlers.restore();
    assert(!h.status.some(x=>x.includes('실패')));
    h.scope={workspace_id:'workspace',column_ids:['trade','cleaned']};
    return h;
}
test('formula uses requested noncontiguous columns instead of current replacement result',async()=>{
    const h=await setup();
    const selection=await h.controller.formulaTarget(h.scope);
    assert.equal(selection.column_start,2);assert.equal(selection.column_count,24);
    assert.equal(selection.row_count,90000);
    assert.deepEqual(Array.from(selection.input_columns,c=>c.column_id),['trade','cleaned']);
    const excel=createHost({rows:90000,sourceColumns:30,data:(r,c)=>`r${r}c${c}`});excel.load('formula/formula_sheet.js');
    const payload=await excel.window.formulaSheet.readFormulaContext(selection);
    assert.deepEqual(Array.from(payload.samples[0].cells),['r1c2','r1c25']);
    assert.equal(payload.workspace_id,'workspace');assert.equal(payload.input_columns.length,2);
    await h.controller.validateFormulaSource(payload);
});
test('missing scope, stale workspace or deleted input never falls back to last result',async()=>{
    const h=await setup();
    await assert.rejects(()=>h.controller.formulaTarget(),/입력 열/);
    await assert.rejects(()=>h.controller.formulaTarget({...h.scope,workspace_id:'other'}),/입력 열/);
    h.columns=h.columns.filter(c=>c.column_id!=='cleaned');
    await assert.rejects(()=>h.controller.formulaTarget(h.scope),/삭제/);
});
test('column movement or rename after planning blocks approval',async()=>{
    const h=await setup();const selection=await h.controller.formulaTarget(h.scope);
    const column=h.columns.find(c=>c.column_id==='cleaned');
    column.column_index=26;
    await assert.rejects(()=>h.controller.validateFormulaSource(selection),/바뀌었습니다/);
    column.column_index=25;column.header='renamed';
    await assert.rejects(()=>h.controller.validateFormulaSource(selection),/바뀌었습니다/);
});
test('manual source reselection inside workspace keeps stable column IDs and chosen rows',async()=>{
    const h=await setup();h.selection={row_start:20,row_count:50,columns:[h.columns[1],h.columns[5]]};
    const selection=await h.controller.formulaTarget(null,true);
    assert.equal(selection.row_start,20);assert.equal(selection.row_count,50);
    assert.equal(selection.workspace_id,'workspace');
    assert.deepEqual(Array.from(selection.input_columns,c=>c.column_id),['trade','cleaned']);
});
test('result IDs are resolved before reporting success; last result only changes after confirmation',async()=>{
    const h=await setup();const selection=await h.controller.formulaTarget(h.scope);
    h.columns.push({column_id:'formula-result',column_index:26,header:'조건 추출',role:'reference',description:''});
    const result={targets:[{row_start:1,row_count:90000,column_start:26,column_count:1}]};
    const ids=await h.controller.formulaResultColumns(result,selection);
    assert.deepEqual(Array.from(ids),['formula-result']);
    assert.deepEqual(Array.from((await h.controller.context()).last_result_column_ids),['replaced']);
    await h.controller.formulaResult(result,selection,ids);
    assert.deepEqual(Array.from((await h.controller.context()).last_result_column_ids),['formula-result']);
    await h.controller.configure({kind:'replace',column_ids:['grouped'],find:'X',replacement:'Y'});
    assert.deepEqual(Array.from(h.configured.column_ids),['grouped']);
    assert.deepEqual(Array.from((await h.controller.context()).target_column_ids),['grouped']);
});

test('workspace restoration notifies reference documents with identity and no cell data', async () => {
    const h = await setup();
    assert.equal(h.reference.workspace_id, 'workspace');
    assert.equal(h.reference.task_type, 'model_normalization');
    assert.equal(h.reference.table_id, 'table');
    assert.equal('columns' in h.reference, false);
    assert.equal(JSON.stringify(h.controller.referenceTarget()), JSON.stringify(h.reference));
});
