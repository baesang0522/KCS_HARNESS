const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
async function run(failedReport) {
    let handlers, currentValue='직접 수정한 X'; const events=[];
    const operation={kind:'replace',column_ids:['old-grouped'],find:'X',replacement:'Y'};
    const workspace={columns:[{column_id:'old-grouped',header:'예전 통일 결과',description:''}]};
    const ui=new Proxy({bind:x=>{handlers=x;},targets:()=>['old-grouped'],operation:()=>operation,
        output:()=>({name:'다시 치환',anchor:'old-grouped',side:'after'})},{get:(o,k)=>o[k]||(()=>{})});
    const window={createOperationsUI:()=>ui,operationsSheet:{
        read:async(w,t,ids)=>{assert.equal(ids[0],'old-grouped');events.push('read');return {workspace,
            columns:workspace.columns,rows:[{excel_row:2,values:[currentValue]}]};},
        write:async(snapshot,values)=>{events.push('write');assert.equal(values[0][0],'직접 수정한 Y');
            return {row_count:1,columns:[{column_id:'new-result'}]};}
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/operations/operations.js'),'utf8'),{window,console,AbortController});
    const controller=window.createOperations({api:{},isBusy:()=>false,setBusy(){},refresh:async()=>false,
        status(){},complete(){},changed(){},result:async()=>events.push('register'),
        jobs:{create:async()=>({source:{operation_job_id:"job"}}),preview:async(job,rows)=>({headers:['결과'],changed_count:1,
            rows:rows.map(row=>({...row,values:[row.values[0].replace('X','Y')]}))}),
            beginApply:async()=>events.push('APPLYING'),status:async(job,status)=>{
                events.push(status);if(status==='APPLIED'&&failedReport)throw new Error('lost report');
            }}});
    controller.show(workspace,{row_start:1,row_count:1},['old-grouped'],true);
    controller.configure(operation);
    await handlers.preview();await handlers.apply();
    return events;
}
test('editing an earlier result reads current values and registers only after completion',async()=>{
    const events=await run(false);
    assert(events.indexOf('read')<events.indexOf('write'));
    assert(events.indexOf('write')<events.indexOf('APPLIED'));
    assert(events.indexOf('APPLIED')<events.indexOf('register'));
});
test('unconfirmed regular operation does not replace last successful result',async()=>{
    const events=await run(true);
    assert(events.includes('UNKNOWN'));assert(!events.includes('register'));
});

test('server settings error is displayed once and prevents Excel reads or writes', async () => {
    const events = []; let handlers;
    const serverMessage = '찾을 문자열을 입력하세요.';
    const ui = new Proxy({bind: value => { handlers = value; },
        operation: () => ({kind: 'replace', column_ids: ['model'], find: '', replacement: 'X'})},
        {get: (object, key) => object[key] || (() => {})});
    const window = {createOperationsUI: () => ui, operationsSheet: {
        read: async () => { events.push('read'); }, write: async () => { events.push('write'); }
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/static/excel/operations/operations.js'), 'utf8'),
        {window, console: {error() {}}, AbortController});
    const controller = window.createOperations({api: {}, isBusy: () => false, setBusy() {},
        refresh: async () => false, status() {}, changed() {}, complete: message => events.push(message),
        jobs: {create: async () => { throw Object.assign(new Error(serverMessage), {status: 422}); },
            status: async () => events.push('status')}});
    controller.show({columns: []}, {row_start: 1, row_count: 90000}, [], true);
    await handlers.preview();
    assert.deepEqual(events, [serverMessage]);
});


test('operation requests retain per-job origins, clear stale origins, and carry write failures',async()=>{
    const bodies=[];let handlers, serial=0;
    const operation={kind:'preprocess',column_ids:['in'],rules:[{operation:'trim'}]};
    const workspace={workspace_id:'work',worksheet_id:'sheet',table_id:'table',task_type:'investigation',columns:[{column_id:'in'}]};
    const ui=new Proxy({bind:x=>{handlers=x;},operation:()=>operation,output:()=>({mode:'new',anchor:'in',name:'out'})},
        {get:(o,k)=>o[k]||(()=>{})});
    const window={createOperationsUI:()=>ui,operationsSheet:{
        read:async()=>({workspace,columns:workspace.columns,rows:[{excel_row:2,values:[' A ']}]}),
        write:async()=>{throw new Error('Excel write disconnected');}
    }};
    const sandbox={window,console,AbortController};
    for (const file of ['operation_jobs.js','operations.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/operations',file),'utf8'),sandbox);
    const api={newRequestId:()=> 'job-'+ ++serial,requestJson:async(url,options)=>{
        const body=JSON.parse(options.body);bodies.push({url,body});
        if(url==='/operation-jobs')return {source:body};
        if(url.includes('/preview'))return {headers:['결과'],changed_count:1,rows:body.rows.map(r=>({...r,values:['A']}))};
        return {};
    }};
    const controller=window.createOperations({api,isBusy:()=>false,setBusy(){},refresh:async()=>false,status(){},complete(){},changed(){},
        jobs:window.createOperationJobs(api,()=> 'conversation')});
    controller.show(workspace,{row_start:1,row_count:1},['in'],true);
    controller.configure(operation,'first-chat');await handlers.preview();await handlers.apply();
    controller.reset();controller.show(workspace,{row_start:1,row_count:1},['in'],true);
    controller.configure(operation);await handlers.preview();
    const creations=bodies.filter(x=>x.url==='/operation-jobs');
    assert.deepEqual(creations.map(x=>x.body.origin_request_id),['first-chat',null]);
    const unknown=bodies.find(x=>x.body.status==='UNKNOWN');
    assert(unknown.url.includes('/job-1/'));
    assert.equal(unknown.body.error_message,'Excel write disconnected');
    assert(!bodies.some(x=>x.body.status==='APPLIED'));
});
