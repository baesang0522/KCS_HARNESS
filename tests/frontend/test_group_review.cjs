const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
const noop=()=>{};
async function setup(){
    const h=createDOM(),host=createInvestigationHost();
    const f=host.workspace(['id','상호','국가','모델','판정','메모'],[[1,'ACME','US','AB-1','old',''],[2,'ACM E','US','AB1','keep',''],[3,'ACME','CN','AB-1','manual',''],[4,'BETA','US','CD2','no','']]);
    f.work.workspace_id='work';f.work.group_reviews=[];
    h.sandbox.Excel=host.Excel;h.window.operationsSheet=host.window.operationsSheet;h.window.workspaceTable=host.window.workspaceTable;
    ['group_review/group_review_model.js','group_review/group_review.js'].forEach(h.load);
    let busy=false,saved,filter,calls=0;
    const api={newRequestId:()=> 'g-'+(++calls),requestJson:async(url,options)=>{
        const body=JSON.parse(options.body),base=body.settings.base_value;
        return {rows:body.rows.filter(r=>r.value!==base).map(r=>({base,candidate:r.value,score:80}))};
    }};
    let controller=h.window.createGroupReview({api,isBusy:()=>busy,setBusy:v=>{busy=v;controller.busy(v);},
        getInput:async()=>({workspace:f.work,target:f.target}),
        saveReview:async review=>{f.work.group_reviews=f.work.group_reviews.filter(r=>r.id!==review.id).concat(structuredClone(review));saved=structuredClone(f.work.group_reviews);},
        register:async result=>{f.work.columns=f.work.columns.filter(c=>!result.columns.some(r=>r.column_id===c.column_id)).concat(result.columns);},
        setFilter:async value=>{filter=value;f.work.row_filter=value;}});
    const node=id=>h.document.getElementById('gr-'+id);
    const click=(parent,label)=>{const b=parent.querySelectorAll('button').find(b=>b.textContent===label);assert(b,label);return b.emit('click');};
    const check=async(input,value=true)=>{input.checked=value;await input.emit('change');};
    await controller.open(f.work.columns[0].column_id);
    return {...h,host,f,controller,node,click,check,get saved(){return saved;},get filter(){return filter;}};
}
async function load(h,refs=[1]){
    const checks=h.node('references').querySelectorAll('input');
    for(const i of refs) await h.check(checks[i]);
    await h.node('load').emit('click');
}
async function saveGroup(h,indexes,name){
    const checks=h.node('values').querySelectorAll('input');
    for(const i of indexes)await h.check(checks[i]);
    h.node('name').value=name;await h.node('save').emit('click');
}
function groupRow(h,index=0){return h.node('groups').children[index];}

test('company groups are explicit, stored independently from model groups, with persistent rejection',async()=>{
    const h=await setup();await load(h);
    assert.equal(h.f.work.group_reviews[0].groups.length,0);
    await h.click(h.node('values').children[0],'비교 기준');await h.node('compare').emit('click');
    await h.click(h.node('candidates').children[0],'다른 대상');
    const rejected=h.f.work.group_reviews[0].rejected[0];assert(rejected);
    await saveGroup(h,[0,1],'ACME 그룹');assert.equal(h.f.work.group_reviews[0].groups[0].status,'draft');
    assert.equal(h.f.sheet.cells[1][1],'ACME');
    await h.click(groupRow(h),'확정');assert.equal(h.f.work.group_reviews[0].groups[0].status,'confirmed');
    await h.controller.open(h.f.work.columns[2].column_id);await load(h,[]);await saveGroup(h,[0],'AB 계열');
    assert.equal(h.f.work.group_reviews.length,2);
    assert(h.f.work.group_reviews.find(r=>r.column_ids[0]===h.f.work.columns[0].column_id).rejected.includes(rejected));
});

test('manual source/context edits invalidate only affected groups; unrelated edits and sorting preserve confirmation',async()=>{
    const h=await setup();await load(h);await saveGroup(h,[0,1],'A');await h.click(groupRow(h),'확정');
    await saveGroup(h,[3],'B');await h.click(groupRow(h,1),'확정');
    h.f.sheet.cells[1][5]='user memo';h.f.sheet.cells.splice(1,4,...h.f.sheet.cells.slice(1).reverse());
    await h.node('load').emit('click');assert(h.f.work.group_reviews[0].groups.every(g=>g.status==='confirmed'));
    h.f.sheet.cells.find(r=>r[0]===1)[2]='GB';await h.node('load').emit('click');
    const groups=h.f.work.group_reviews[0].groups;
    assert.equal(groups.find(g=>g.name==='A').status,'review');assert.equal(groups.find(g=>g.name==='B').status,'confirmed');
    await h.click(groupRow(h),'확정');assert.match(h.node('status').textContent,/다시 저장/);
    await h.click(groupRow(h),'구성 확인 / 수정');
    await h.node('save').emit('click');
    const a=h.node('groups').children.find(row=>row.textContent.startsWith('A ·'));
    await h.click(a,'확정');assert.equal(h.f.work.group_reviews[0].groups.find(g=>g.name==='A').status,'confirmed');
});

test('preview detects silent destination edits; sparse existing writes preserve excluded rows and manual values',async()=>{
    const h=await setup();await load(h);await saveGroup(h,[0,1],'A');await h.click(groupRow(h),'확정');
    await h.check(groupRow(h).querySelector('input'));
    h.node('destination').value=h.f.work.columns[3].column_id;h.node('output-kind').value='mark';h.node('mark').value='Y';
    await h.node('preview').emit('click');assert.equal(h.node('apply').disabled,false,h.node('status').textContent);
    h.f.sheet.cells[1][4]='direct edit';await h.node('apply').emit('click');assert.match(h.node('status').textContent,/바뀌었습니다/);
    assert.equal(h.f.sheet.cells[1][4],'direct edit');assert.equal(h.node('apply').disabled,true);
    await h.node('preview').emit('click');await h.node('apply').emit('click');
    assert.deepEqual(h.f.sheet.cells.slice(1).map(r=>r[4]),['Y','Y','manual','no']);
    assert.equal(h.f.work.row_filter,undefined);
    await h.node('filter').emit('click');assert.equal(h.f.work.row_filter.value,'Y');
});

test('groups can exclude members and resume after reload; scope is independent of existing filter',async()=>{
    const h=await setup();await load(h);await saveGroup(h,[0,1],'A');
    await h.click(groupRow(h),'구성 확인 / 수정');await h.check(h.node('values').querySelectorAll('input')[1],false);
    await h.node('save').emit('click');assert.deepEqual(Array.from(h.f.work.group_reviews[0].groups[0].members.flatMap(m=>m.ids)),[1]);
    h.f.work.row_filter={column_id:h.f.work.columns[3].column_id,operator:'equals',value:'no'};
    await h.controller.open();h.node('saved').value=h.f.work.group_reviews[0].id;await h.node('saved').emit('change');
    await h.node('load').emit('click');assert.equal(h.node('values').children.length,4);
    h.node('scope').value='current';await h.node('scope').emit('change');await h.node('load').emit('click');
    assert.equal(h.node('values').children.length,1);assert.match(h.node('values').textContent,/BETA/);
});

test('identities allow sorted sparse writes, reject missing members and refuse edits after preview',async()=>{
    const h=createInvestigationHost(),f=h.workspace(['id','값','출력'],[[1,'A','x'],[2,'B','keep'],[3,'C','z']]);
    const id=f.work.columns[0].column_id,out=f.work.columns[1].column_id;
    f.sheet.cells.splice(1,3,...f.sheet.cells.slice(1).reverse());
    const snapshot=await h.window.operationsSheet.read(f.work,f.target,[id],noop,noop,out,null,[1,3]);
    await h.window.operationsSheet.write(snapshot,[['C-group'],['A-group']],['출력'],{mode:'existing',column_id:out},noop);
    assert.deepEqual(f.sheet.cells.slice(1).map(r=>r[2]),['C-group','keep','A-group']);
    await assert.rejects(()=>h.window.operationsSheet.read(f.work,f.target,[id],noop,noop,out,null,[99]),/삭제/);
});


test('new result is reusable as existing output; members changed after confirmation cannot be written',async()=>{
    const h=await setup();await load(h);await saveGroup(h,[0,1],'A');await h.click(groupRow(h),'확정');
    await h.check(groupRow(h).querySelector('input'));
    h.node('destination').value='';h.node('output-kind').value='mark';h.node('mark').value='Y';h.node('output-name').value='선정';
    await h.node('preview').emit('click');await h.node('apply').emit('click');
    const count=h.f.table.columns.items.length;
    assert.equal(h.node('destination').value,h.f.work.columns.find(c=>c.header==='선정').column_id);
    h.node('mark').value='추가 검토';await h.node('mark').emit('input');
    await h.node('preview').emit('click');await h.node('apply').emit('click');assert.equal(h.f.table.columns.items.length,count);
    h.f.sheet.cells[1][1]='manual source';
    await h.node('preview').emit('click');assert.equal(h.node('apply').disabled,true);
    assert.equal(h.f.work.group_reviews[0].groups[0].status,'review');
});

test('renaming and moving the source column preserves group identity; deleted identities block writes',async()=>{
    const h=await setup();await load(h);await saveGroup(h,[0,1],'A');await h.click(groupRow(h),'확정');
    h.host.moveColumn(h.f.sheet,1,3);h.f.table.columns.items[3].name='옮긴 상호';
    await h.node('load').emit('click');assert.equal(h.f.work.group_reviews[0].groups[0].status,'confirmed');
    await h.check(groupRow(h).querySelector('input'));h.node('destination').value=h.f.work.columns[3].column_id;
    h.f.sheet.cells[1][0]='';await h.node('preview').emit('click');
    assert.equal(h.node('apply').disabled,true);assert.match(h.node('status').textContent,/식별값/);
});


test('requested reference text and marking fields survive loading; no rows selected or written without review',async()=>{
    const h=await setup(),request={match_text:'ACME INTL TRADE',output_name:'분석대상',assigned_value:'분석대상'};
    await h.controller.open(h.f.work.columns[0].column_id,request);
    assert.equal(h.node('query').value,request.match_text);assert.equal(h.node('comparison').open,true);
    await load(h);assert.equal(h.node('output-kind').value,'mark');assert.equal(h.node('output-name').value,'분석대상');
    await h.node('compare').emit('click');
    assert.equal(h.node('values').querySelectorAll('input').filter(i=>i.checked).length,0);
    await h.node('preview').emit('click');assert.equal(h.node('apply').disabled,true);
    assert.equal(h.f.table.columns.items.length,6);
    await h.click(h.node('candidates').children[0],'이 후보 선택');
    h.node('name').value='검토한 기업';await h.node('save').emit('click');await h.click(groupRow(h),'확정');
    await h.check(groupRow(h).querySelector('input'));await h.node('preview').emit('click');await h.node('apply').emit('click');
    const column=h.f.work.columns.find(c=>c.header==='분석대상');assert(column,h.node('status').textContent);
    assert.deepEqual(h.f.sheet.cells.slice(1).map(r=>r[column.column_index]),['분석대상','','','']);
});
