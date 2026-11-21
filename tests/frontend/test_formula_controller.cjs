const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function setup(fail=false, config={}) {
    let handlers,timer;
    const requests=[],messages=[],status=[],bodies=[],events=[];
    let validations=0, scopeSeen, referencesSeen;
    const preview={preview_id:'preview',plan:{actions:[{target_range:'C2:C90001',anchor_cell:'C2'}]}};
    const result={address:'Sheet1!C2:C90001',row_count:90000,targets:[{row_start:1,row_count:90000,column_start:2,column_count:1}]};
    const sandbox={window:{setTimeout:fn=>{timer=fn;},clearTimeout(){}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel/formula/formula.js'),'utf8'),sandbox);
    let writes=0,shown=0,offer=false;
    const controller=sandbox.window.createFormulaController({
        ui:{bind:x=>{handlers=x;},open(){},reset(){offer=false;},setStatus:x=>status.push(x),showPreview(){shown++;offer=true;},setApplied(){offer=false;}},
        api:{newRequestId:()=> 'request',requestJson:async (url,options)=> {
            requests.push(url);
            events.push(url.split("/").at(-1));
            if(options.body)bodies.push({url,body:JSON.parse(options.body)});
            if(config.failAt && url.endsWith("/"+config.failAt))throw new Error("network lost");
            if(url.endsWith('/analyze') && config.analysis)return config.analysis;
            if(url.endsWith('/approve'))return preview;
            if(url.endsWith('/failed'))return {formula_job_id:'job',status:'FAILED',preview};
            return {formula_job_id:'job',status:'PREVIEW_READY',preview};
        }},
        excel:{readFormulaContext:async(target,names)=>{referencesSeen=names;return {row_count:90000,...(config.references ? {reference_sheets:config.references} : {})};},prepareFormulaPreview:async()=>{if(config.prepareFails)throw new Error('output occupied');return {target_range:'C2:C90001',anchor_cell:'C2'};},
            validateFormulaPreview:async()=>{},applyFormulaPreview:async (p,s,progress)=> {
                writes++;
                progress('수식 작성',1000,90000);
                if(fail)throw new Error('partial error');
                return result;
            }},
        resolveOutput:async()=>{if(config.resolveFails)throw new Error("unsupported placement");return null;},
        getTarget:async scope=>{scopeSeen=scope;return null;},
        validateSource:async()=>{if(++validations===2&&config.moved)throw new Error('source moved');},
        getResultColumns:async()=>['result'],
        onResult:async()=>{events.push('register');if(config.registrationFails)throw new Error('save failed');},
        isBusy:()=>false,isReady:()=>true,getConversationId:()=> 'conversation',
        beginRequest:()=>({controller:new AbortController()}),checkRequest(){},endRequest(){},setBusy(){},
        complete:x=>messages.push(x)
    });
    return {start:async()=>{controller.openAndSelect('합산',{workspace_id:'work',column_ids:['a','b'],...(config.output ? {output:config.output} : {}),...(config.referenceNames ? {reference_sheet_names:config.referenceNames} : {}),...(config.origin ? {origin_request_id:config.origin} : {})});await timer();},apply:()=>handlers.apply(),cancel:()=>handlers.cancel(),changeOutput:action=>controller.changeOutput(action),get shown(){return shown;},get offer(){return offer;},requests,messages,status,bodies,events,get scope(){return scopeSeen;},get referencesSeen(){return referencesSeen;},get writes(){return writes;}};
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
    assert(h.messages.at(-1).includes('계산 결과를 값으로 저장했습니다'));
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
    assert.equal(h.offer,false);assert(h.requests.at(-1).endsWith('/failed'));
    await h.apply();assert.equal(h.writes,0);
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


test('workspace formula request announces automatic lookup rather than asking for selection',async()=>{
    const h=setup();await h.start();
    assert(h.status.some(text=>text.includes('요청한 열을 작업표에서')));
    assert(h.status.some(text=>text.includes('90,000행으로 수식 계획')));
    assert(!h.status.some(text=>text.includes('Excel에서 선택한 범위를 가져옵니다')));
    assert.equal(h.writes,0);
});


test('formula creation retains its chat origin and unknown writes report the client failure', async () => {
    const h=setup(true,{origin:'chat-origin'});await h.start();await h.apply();
    assert.equal(h.bodies.find(x=>x.url==='/formula-jobs').body.origin_request_id,'chat-origin');
    assert.equal(h.bodies.find(x=>x.url.endsWith('/unknown')).body.error_message,'partial error');
    assert(!h.requests.some(x=>x.endsWith('/complete')));
});


test('formula controller forwards named references to Excel and actual contexts to the planning job',async()=>{
 const references=[{worksheet_id:'reference',sheet_name:'거래처검토_ref',address:'거래처검토_ref!A1:C102'}];
 const f=setup(false,{referenceNames:['거래처검토'],references});await f.start();
 assert.deepEqual(f.referencesSeen,['거래처검토']);
 assert.deepEqual(f.bodies.find(x=>x.url==='/formula-jobs').body.reference_sheets,references);
 assert.equal(f.writes,0);
});


test('new named formula column reaches the preview without invented insertion placement',async()=>{
 const h=setup(false,{output:{mode:'new',name:'작업대상여부'}});await h.start();
 assert.equal(h.shown,1);assert.equal(h.offer,true);assert.equal(h.writes,0);
 assert.match(h.bodies.find(x=>x.url==='/formula-jobs').body.instruction,/결과 열 이름: 작업대상여부/);
 assert(!h.requests.some(x=>x.endsWith('/failed')));
});
test('destination or preview validation failure is reported before allowing another chat',async()=>{
 for(const config of [{resolveFails:true,output:{mode:'new'}},{prepareFails:true}]){
  const h=setup(false,config);await h.start();await h.apply();
  assert.equal(h.shown,0);assert.equal(h.offer,false);assert.equal(h.writes,0);
  assert.match(h.requests.at(-1),/previews\/preview\/failed$/);
  assert.match(h.bodies.at(-1).body.error_message,/unsupported placement|output occupied/);
  assert(!h.requests.some(x=>x.endsWith('/approve')));
 }
});
test('failed status delivery preserves local invalidation and explains server uncertainty',async()=>{
 const h=setup(false,{prepareFails:true,failAt:'failed'});await h.start();await h.apply();
 assert.equal(h.offer,false);assert.equal(h.writes,0);
 assert.match(h.messages.at(-1),/서버에 미리보기 실패를 전달하지 못했습니다/);
 assert.match(h.messages.at(-1),/현재 화면에 적용할 미리보기는 없습니다/);
});
test('cancelled and failed relocated previews are no longer offered locally or on the server',async()=>{
 const h=setup();await h.start();assert.equal(h.offer,true);await h.cancel();await h.apply();
 assert.equal(h.offer,false);assert.equal(h.writes,0);assert(h.requests.at(-1).endsWith('/failed'));
 const g=setup();await g.start();
 await assert.rejects(()=>g.changeOutput({formula_job_id:'job',output:{mode:'new',name:'changed'}}),/이름을 바꾸려면/);
 assert.equal(g.offer,false);assert(g.requests.at(-1).endsWith('/failed'));await g.apply();assert.equal(g.writes,0);
});

test('failed planning cannot offer or approve a preview; a later request can recover',async()=>{
 const config={analysis:{formula_job_id:'job',status:'FAILED',preview:null,error:'JSON 형식 오류'}};
 const h=setup(false,config);await h.start();await h.apply();
 assert.equal(h.shown,0);assert.equal(h.offer,false);assert.equal(h.writes,0);
 assert.match(h.messages.at(-1),/JSON 형식 오류/);
 assert(!h.requests.some(url=>/approve|failed|complete/.test(url)));
 delete config.analysis;await h.start();
 assert.equal(h.shown,1);assert.equal(h.offer,true);assert.equal(h.writes,0);
 await h.apply();assert.equal(h.writes,1);assert.equal(h.requests.filter(url=>url.endsWith('/complete')).length,1);
});
test('planning clarification has no apply offer and waits for another request',async()=>{
 const h=setup(false,{analysis:{formula_job_id:'job',status:'NEEDS_INPUT',clarification:'조회 열을 알려줘',preview:{plan:{actions:[]}}}});
 await h.start();await h.apply();
 assert.equal(h.shown,0);assert.equal(h.writes,0);assert.equal(h.messages.at(-1),'조회 열을 알려줘');
 assert(!h.requests.some(url=>url.endsWith('/approve')));
});
