const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost} = require('../helpers/investigation_host.cjs');

function sheetFixture() {
    const h = createDOM(), host = createInvestigationHost();
    const f = host.workspace(['id', '상호', '판정'], [[1,'AA','Y'],[2,'AB','N'],[3,'AA','Y']]);
    f.work.row_filter = {column_id: f.work.columns[1].column_id, operator:'equals',value:'Y'};
    h.sandbox.Excel=host.Excel; h.sandbox.Office={context:{requirements:{isSetSupported:()=>true}}};
    ['workspace/workspace_sheet.js','workspace/table_reader.js','operations/operations_sheet.js','chat/agent_sheet.js'].forEach(h.load);
    const expected={...f.work, row_count:f.target.row_count,row_start:f.target.row_start};
    const input=async()=>({workspace:f.work,target:f.target});
    return {h,host,f,expected,input};
}
test('agent reads only current IDs/conditions, returns zero matches, and never writes', async()=>{
    const {h,host,f,expected,input}=sheetFixture();
    const result=await h.window.readAgentData(input,expected,{column_ids:[f.work.columns[0].column_id]},()=>{},()=>{});
    assert.deepEqual(Array.from(result.rows,r=>r.identity),[1,3]);assert.equal(host.writes.length,0);
    const empty=await h.window.readAgentData(input,expected,{column_ids:[f.work.columns[0].column_id],
        condition:{column_id:f.work.columns[0].column_id,operator:'equals',value:'absent'}},()=>{},()=>{});
    assert.equal(empty.rows.length,0);assert.equal(host.writes.length,0);
});
test('read receipt rejects later edits, sort, deleted columns, changed filters and a different table',async()=>{
    for(const mutate of [f=>f.sheet.cells[1][1]='EDIT',f=>f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse()),
        f=>f.table.columns.items.splice(1,1),f=>f.work.row_filter.value='N',f=>f.work.table_id='another']) {
        const {h,f,expected,input}=sheetFixture();
        const result=await h.window.readAgentData(input,structuredClone(expected),{column_ids:[f.work.columns[0].column_id]},()=>{},()=>{});
        mutate(f);await assert.rejects(result.verify);
    }
});
test('agent read checks cancellation between Excel chunks',async()=>{
    const {h,host,f,expected,input}=sheetFixture();let checks=0;
    await assert.rejects(h.window.readAgentData(input,expected,{column_ids:[f.work.columns[0].column_id]},()=>{},()=>{
        if(++checks===3)throw new DOMException('stop','AbortError');
    }),/stop/);assert.equal(host.writes.length,0);
});

async function setup() {
    const h=createDOM();h.window.setTimeout=setTimeout;h.window.clearTimeout=clearTimeout;
    h.load('chat/chat.js');h.load('chat/agent.js');
    let serial=0, agent, stage=0;
    const requests=[],actions=[],timers=[];
    const context={workspace_id:'work',worksheet_id:'sheet',table_id:'table',task_type:'investigation',sheet_name:'조사',row_count:3,row_start:1,
        columns:[{column_id:'name',header:'상호',role:'reference'}],target_column_ids:['name']};
    const workspace={context:async()=>structuredClone(context),agentInput:async()=>({}),previewOperation:async()=>actions.push('preview')};
    h.respond=async(url,body)=>{
        if(url==='/conversations')return {conversation_id:'conversation'};
        if(url==='/chat')return {answer:'시작',ui_action:{type:'agent_run',run_id:'run'}};
        if(url.endsWith('/cancel'))return {status:'cancelled'};
        if(url.endsWith('/pause'))return {...h.state,status:'PAUSED'};
        if(url.endsWith('/bind'))return {...h.state,step:{...h.state.step,job:{job_id:body.job_id,kind:body.kind}}};
        if(url.endsWith('/advance')) {
            stage++;return stage===1?state('WAITING_EXCEL',{type:'agent_read',read:{column_ids:['name']}},'step1'):
                state('COMPLETED',null,null,{kind:'read',column_ids:['name'],row_count:2,groups:[{values:['AA'],count:2,first_excel_row:2,first_row_id:1}]});
        }
        return null;
    };
    function state(status,action,id,observation=null) {
        return h.state={run_id:'run',goal:'값을 확인해줘',status,answer:status==='COMPLETED'?'실제 2행 확인':'현재 범위 읽기',workspace:context,
            step:action?{step_id:id,action,job:null}:null,observation};
    }
    const api={newRequestId:()=> 'request-'+ ++serial,requestJson:async(url,options={})=>{
        const body=options.body?JSON.parse(options.body):null;requests.push({url,body,signal:options.signal});return h.respond(url,body,options);
    }};
    const chat=h.window.createChatController({api,getWorkspace:()=>workspace,closeTaskCards(){},resetTasks(){},
        handleUIAction:async action=>{if(action)actions.push(action);if(h.onAction)await h.onAction(action);},runAgent:(action,run)=>agent.run(action,run),
        beforeManualAction:()=>agent.detach(),onBusy:value=>{if(!value&&agent)agent.flush();}});
    agent=h.window.createAgentController({api,chat,getWorkspace:()=>workspace,handleUIAction:async action=>{if(action)actions.push(action);if(h.onAction)await h.onAction(action);}});
    h.window.readAgentData=async()=>({rows:[{identity:1,excel_row:2,values:['AA']},{identity:3,excel_row:4,values:['AA']}],verify:async()=>{}});
    await chat.initialize();
    h.document.getElementById('message').value='값을 확인해줘';
    return {...h,chat,agent,context,requests,actions,state,workspace,setRespond:fn=>{h.respond=fn;},getRespond:()=>h.respond,setAction:fn=>{h.onAction=fn;}};
}
test('one chat request drives read-result-final and exposes exact data without writing',async()=>{
    const h=await setup();await h.chat.sendMessage();
    const advances=h.requests.filter(r=>r.url.endsWith('/advance'));
    assert.equal(advances.length,2);assert.deepEqual(advances[1].body.receipt.rows.map(r=>r.identity),[1,3]);
    assert.equal(h.actions.length,0);assert.equal(h.chat.isBusy(),false);
    assert.match(h.document.getElementById('conversation').textContent,/실제 2행 확인/);
    assert.match(h.document.getElementById('conversation').textContent,/실행 결과 · 2행/);
});
test('stop while Excel is reading cancels the exact server step and ignores late data',async()=>{
    const h=await setup();let finish,started;const ready=new Promise(r=>started=r);
    h.window.readAgentData=()=>new Promise(resolve=>{finish=resolve;started();});
    const running=h.chat.sendMessage();await ready;
    const last=h.requests.find(r=>r.url.endsWith('/advance'));
    await h.document.getElementById('composer').emit('submit');
    finish({rows:[],verify:async()=>{}});await running;
    assert(h.requests.some(r=>r.url.endsWith('/requests/'+last.body.request_id+'/cancel')));
    assert.equal(h.requests.filter(r=>r.url.endsWith('/advance')).length,1);
    assert.equal(h.actions.length,0);assert.equal(h.chat.isBusy(),false);
});
test('sheet changed during model response suppresses stale completion without rewriting its server receipt',async()=>{
    const h=await setup();h.window.readAgentData=async()=>({rows:[],verify:async()=>{throw new Error('입력값이 바뀌었습니다.');}});
    await h.chat.sendMessage();
    assert(!h.requests.some(r=>r.url.endsWith('/pause')));
    assert(!h.document.getElementById('conversation').textContent.includes('실제 2행 확인'));
    assert.match(h.document.getElementById('conversation').textContent,/입력값이 바뀌었습니다/);
});
test('write handoff binds actual job and continues only after user completion with fresh context',async()=>{
    const h=await setup();let advances=0;const original=h.getRespond();
    h.setRespond(async(url,body,options)=>{
        if(url.endsWith('/advance')) {
            if(++advances===1)return h.state('WAITING_USER',{type:'configure_operation',operation:{kind:'replace',column_ids:['name'],find:'A',replacement:'B'}},'write-step');
            assert.equal(body.receipt.step_id,'write-step');assert.equal(body.workspace.row_filter.value,'N');
            return h.state('COMPLETED',null,null);
        }
        return original(url,body,options);
    });
    await h.chat.sendMessage();assert.equal(advances,1);assert.equal(h.actions.length,1);
    await h.agent.bind('operation','job');h.context.row_filter={column_id:'name',operator:'equals',value:'N'};
    h.agent.complete({kind:'operation',job_id:'job',status:'SUCCEEDED'},'완료');h.agent.flush();
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(advances,2);assert.equal(h.chat.isBusy(),false);
});
test('manual pause prevents a late completion callback from restarting the agent',async()=>{
    const h=await setup();const original=h.getRespond();let advances=0;
    h.setRespond(async(url,body,options)=>url.endsWith('/advance')?(advances++,h.state('WAITING_USER',{
        type:'configure_operation',operation:{kind:'replace'}},'step')):original(url,body,options));
    await h.chat.sendMessage();await h.agent.bind('operation','job');await h.agent.pause();
    h.agent.complete({kind:'operation',job_id:'job',status:'SUCCEEDED'},'완료');h.agent.flush();
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(advances,1);
});
test('network receipt retry resends the same ID and data without repeating Excel work',async()=>{
    const h=await setup();let advances=0,reads=0;const original=h.getRespond();
    h.window.readAgentData=async()=>{reads++;return {rows:[],verify:async()=>{}};};
    h.setRespond(async(url,body,options)=>{
        if(url.endsWith('/advance')) {
            if(++advances===2)throw new Error('connection lost');
            if(advances===3)return h.state('COMPLETED',null,null);
        }
        return original(url,body,options);
    });
    await h.chat.sendMessage();assert.equal(reads,1);
    await h.chat.sendMessage();assert.equal(reads,1);
    const sent=h.requests.filter(r=>r.url.endsWith('/advance'));
    assert.deepEqual(sent[1].body,sent[2].body);
});

test('Excel failure is returned to the server without a fabricated success',async()=>{
    const h=await setup();const original=h.getRespond();
    h.window.readAgentData=async()=>{throw new Error('Excel 연결 실패');};
    h.setRespond(async(url,body,options)=>{
        if(body?.receipt?.status==='FAILED')return h.state('FAILED',null,null);
        return original(url,body,options);
    });
    await h.chat.sendMessage();
    const failed=h.requests.find(r=>r.body?.receipt?.status==='FAILED');
    assert(failed);assert.equal(failed.body.receipt.message,'Excel 연결 실패');assert.equal(h.actions.length,0);
});
test('result pagination keeps all rows and renders cell strings as text',async()=>{
    const h=await setup();const original=h.getRespond();
    h.setRespond(async(url,body,options)=>{
        if(body?.receipt) return h.state('COMPLETED',null,null,{kind:'read',column_ids:['name'],row_count:101,
            groups:Array.from({length:101},(_,i)=>({values:[i===100?'<script>last</script>':String(i)],count:1,first_excel_row:i+2}))});
        return original(url,body,options);
    });
    await h.chat.sendMessage();
    const details=h.document.getElementById('conversation').querySelector('details');
    assert.match(details.textContent,/1–100 \/ 101/);
    await details.querySelectorAll('button')[1].emit('click');
    assert.match(details.textContent,/101–101 \/ 101/);assert.match(details.textContent,/<script>last<\/script>/);
    assert.equal(details.querySelectorAll('script').length,0);
});

test('opening manual panels after completion never pauses the completed run or replaces its answer',async()=>{
 const h=await setup();await h.chat.sendMessage();
 const before=h.document.getElementById('conversation').textContent;
 await h.agent.pause();
 assert(!h.requests.some(r=>r.url.endsWith('/pause')));
 assert.equal(h.document.getElementById('conversation').textContent,before);
});


test('automatic group handoff rechecks read evidence at write time and rejects detached execution',async()=>{
    const h=await setup(),original=h.getRespond();let advances=0,changed=false,verified=0;
    h.window.readAgentData=async()=>({rows:[],verify:async()=>{verified++;if(changed)throw new Error('대표값 변경');}});
    h.setRespond(async(url,body,options)=>{
        if(url.endsWith('/advance')&&++advances===2)return h.state('WAITING_USER',{
            type:'configure_operation',auto_apply:true,operation:{kind:'set'}},'auto-step');
        return original(url,body,options);
    });
    await h.chat.sendMessage();
    assert.equal(h.actions[0].auto_apply,true);
    await h.agent.bind('operation','job');
    await h.agent.verifyWrite();assert.equal(verified,2);
    changed=true;await assert.rejects(h.agent.verifyWrite,/대표값 변경/);
    h.agent.detach();await assert.rejects(h.agent.verifyWrite,/최신 조회/);
});


test('three automatic group handoffs continue to completion without any apply click',async()=>{
    const h=await setup(),original=h.getRespond();let stage=0,writes=0,finished;
    const done=new Promise(resolve=>{finished=resolve;});
    h.setRespond(async(url,body,options)=>{
        if(url.endsWith('/advance')) {
            stage++;
            if(stage===7){assert.equal(writes,3);finished();return h.state('COMPLETED',null,null);}
            if(stage%2)return h.state('WAITING_EXCEL',{type:'agent_read',read:{column_ids:['name']}},'read-'+stage);
            return h.state('WAITING_USER',{type:'configure_operation',auto_apply:true,operation:{kind:'set'}},'write-'+stage);
        }
        return original(url,body,options);
    });
    h.setAction(async action=>{
        if(!action)return;
        assert.equal(action.auto_apply,true);
        h.chat.setBusy(true);
        await h.agent.verifyWrite();
        await h.agent.bind('operation','job-'+(++writes));
        h.agent.complete({job_id:'job-'+writes,status:'SUCCEEDED'},'자동 반영');
        h.chat.setBusy(false);
    });
    await h.chat.sendMessage();
    await Promise.race([done,new Promise((_,reject)=>{setTimeout(()=>reject(new Error('automatic progression stalled')),1000).unref();})]);
    assert.equal(h.actions.length,3);
    assert.equal(h.document.getElementById('conversation').querySelectorAll('button').length,0);
});
