const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function setup(fail=false, config={}) {
    let handlers,timer;
    const requests=[],messages=[],status=[],bodies=[],events=[];
    let validations=0, scopeSeen;
    const preview={preview_id:'preview',plan:{actions:[{target_range:'C2:C90001',anchor_cell:'C2'}]}};
    const result={address:'Sheet1!C2:C90001',row_count:90000,targets:[{row_start:1,row_count:90000,column_start:2,column_count:1}]};
    const sandbox={window:{setTimeout:fn=>{timer=fn;},clearTimeout(){}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/formula/formula.js'),'utf8'),sandbox);
    let writes=0;
    const controller=sandbox.window.createFormulaController({
        ui:{bind:x=>{handlers=x;},open(){},reset(){},setStatus:x=>status.push(x),showPreview(){},setApplied(){}},
        api:{newRequestId:()=> 'request',requestJson:async (url,options)=> {
            requests.push(url);
            events.push(url.split("/").at(-1));
            if(options.body)bodies.push({url,body:JSON.parse(options.body)});
            if(config.failAt && url.endsWith("/"+config.failAt))throw new Error("network lost");
            if(url.endsWith('/approve'))return preview;
            return {formula_job_id:'job',status:'PREVIEW_READY',preview};
        }},
        excel:{readFormulaContext:async()=>({row_count:90000}),prepareFormulaPreview:async()=>({target_range:'C2:C90001',anchor_cell:'C2'}),
            validateFormulaPreview:async()=>{},applyFormulaPreview:async (p,s,progress)=> {
                writes++;
                progress('수식 작성',1000,90000);
                if(fail)throw new Error('partial error');
                return result;
            }},
        getTarget:async scope=>{scopeSeen=scope;return null;},
        validateSource:async()=>{if(++validations===2&&config.moved)throw new Error('source moved');},
        getResultColumns:async()=>['result'],
        onResult:async()=>{events.push('register');if(config.registrationFails)throw new Error('save failed');},
        isBusy:()=>false,isReady:()=>true,getConversationId:()=> 'conversation',
        beginRequest:()=>({controller:new AbortController()}),checkRequest(){},endRequest(){},setBusy(){},
        complete:x=>messages.push(x)
    });
    return {start:async()=>{controller.openAndSelect('합산',{workspace_id:'work',column_ids:['a','b']});await timer();},apply:()=>handlers.apply(),requests,messages,status,bodies,events,get scope(){return scopeSeen;},get writes(){return writes;}};
}
test('failed partial apply never reports completion and cannot be retried by button',async()=>{
    const h=setup(true);await h.start();await h.apply();await h.apply();
    assert.equal(h.writes,1);
    assert(!h.requests.some(x=>x.endsWith('/complete')));
    assert(h.messages.at(-1).includes('partial error'));
});
test('successful apply shows progress and reports completion once',async()=>{
    const h=setup();await h.start();await h.apply();await h.apply();
    assert.equal(h.writes,1);
    assert.equal(h.requests.filter(x=>x.endsWith('/complete')).length,1);
    assert(h.status.some(x=>x.includes('1,000/90,000셀')));
});

test('completion carries actual ranges and IDs, followed by local result registration',async()=>{
    const h=setup();await h.start();await h.apply();
    const complete=h.bodies.find(x=>x.url.endsWith('/complete')).body;
    assert.deepEqual(complete.result_column_ids,['result']);
    assert.equal(complete.targets[0].row_count,90000);
    assert(h.events.indexOf('complete')<h.events.indexOf('register'));
    assert.deepEqual(h.scope,{workspace_id:'work',column_ids:['a','b']});
});
test('source changed before approval produces no approval request or writes',async()=>{
    const h=setup(false,{moved:true});await h.start();await h.apply();
    assert.equal(h.writes,0);assert(!h.requests.some(x=>x.endsWith('/approve')));
});
test('lost approval or completion response blocks retry and records uncertainty',async()=>{
    for(const failAt of ['approve','complete']) {
        const h=setup(false,{failAt});await h.start();await h.apply();await h.apply();
        assert.equal(h.writes,failAt==='approve'?0:1);
        assert.equal(h.requests.filter(x=>x.endsWith('/approve')).length,1);
        assert(h.requests.some(x=>x.endsWith('/unknown')));
        assert(!h.events.includes('register'));
    }
});
test('local save failure after confirmed completion never downgrades server result',async()=>{
    const h=setup(false,{registrationFails:true});await h.start();await h.apply();
    assert(h.requests.some(x=>x.endsWith('/complete')));
    assert(!h.requests.some(x=>x.endsWith('/unknown')));
    assert(h.messages.at(-1).includes('다시 쓰지 마세요'));
});
