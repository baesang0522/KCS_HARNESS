const test=require('node:test');
const assert=require('node:assert/strict');
const {createHost,translate}=require('../helpers/excel_mock.cjs');
function plan(rows, columns=['C']) {
    return {plan:{actions:columns.map((col,i)=>({target_range:`${col}2:${col}${rows+1}`,anchor_cell:`${col}2`,
        formula:i?'=C2+1':'=A2+$B$2+A$1+$B2',mode:'fill_down'}))}};
}
test('large selections only load 20 sample rows; 20-column guard remains',async()=>{
    const h=createHost({rows:400001}); h.load('formula/formula_sheet.js');
    const result=await h.window.formulaSheet.readFormulaContext(h.selection);
    assert.equal(result.row_count,400001); assert.equal(result.samples.length,20);
    assert(h.loads.filter(x=>x.properties==='text').every(x=>x.n<=20));
    const wide=createHost({sourceColumns:21}); wide.load('formula/formula_sheet.js');
    await assert.rejects(()=>wide.window.formulaSheet.readFormulaContext(wide.selection),/20열/);
});
test('blank-looking formulas at the last row are occupied; original cells untouched',async()=>{
    const h=createHost(); h.load('formula/formula_sheet.js');
    h.occupied.set('90000,2',{formula:'=""',value:''});
    const result=await h.window.formulaSheet.prepareFormulaPreview(plan(90000),h.selection);
    assert.equal(result.reason,'automatic'); assert.equal(result.target_range,'D2:D90001');
    assert.equal(h.writes.length,0);
    h.selected=h.range(0,2,1,1);
    await assert.rejects(()=>h.window.formulaSheet.readFormulaTarget(plan(90000),h.selection),/기존 값이나 수식/);
});
test('90k and 400001 rows write in bounded batches with relative and absolute references',async()=>{
    for (const count of [90000,400001]) {
        const h=createHost({rows:count}); h.load('formula/formula_sheet.js');
        const updates=[];
        const result=await h.window.formulaSheet.applyFormulaPreview(plan(count,['C','D']),h.selection,
            (label,done,total)=>updates.push({done,total}));
        assert.equal(result.action_count,2); assert.equal(result.row_count,count);
        for(const r of [1,1000,1001,count])for(const c of [2,3])assert.equal(h.formulaAt(r,c),'');
        assert.equal(h.valueCopies.reduce((n,p)=>n+p.n,0),count*2);
        assert(h.writes.every(x=>x.n<=1000));
        assert(h.loads.filter(x=>x.properties==='valueTypes').every(x=>x.n<=1000));
        for (const r of [1,1000,1001,count]) {
            assert.equal(h.calculatedFormulaAt(r,2),translate('=A2+$B$2+A$1+$B2',r-1,0));
            assert.equal(h.calculatedFormulaAt(r,3),`=C${r+1}+1`);
        }
        const firstSecond=h.writes.findIndex(x=>x.c===3);
        assert.equal(h.writes[firstSecond-1].r+h.writes[firstSecond-1].n,count+1);
        assert.deepEqual(updates.at(-1),{done:count*2,total:count*2});
        assert.equal(h.formulaAt(0,2),''); assert.equal(h.formulaAt(count+1,2),'');
    }
});
test('actual Excel errors stop at the failing batch; # text is not an error',async()=>{
    const h=createHost({rows:3000}); h.load('formula/formula_sheet.js'); h.errorRow=1001;
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3000),h.selection),
        /계산 확인 완료 1000셀.*C1002:C2001.*Excel 오류/);
    assert.equal(h.formulaAt(2001,2),'');
});
test('new content between batches is not overwritten',async()=>{
    const h=createHost({rows:3000}); h.load('formula/formula_sheet.js');
    h.beforeSync=()=>{if(h.writes.length)h.occupied.set('1001,2',{value:'user edit'});};
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3000),h.selection),/1000셀.*기존 값/);
    assert.equal(h.formulaAt(1001,2),'');
});
test('single-cell action and overlapping source guard',async()=>{
    const h=createHost({rows:1}); h.load('formula/formula_sheet.js');
    const p={plan:{actions:[{target_range:'C2',anchor_cell:'C2',formula:'=A2',mode:'single'}]}};
    await h.window.formulaSheet.applyFormulaPreview(p,h.selection);
    assert.equal(h.calculatedFormulaAt(1,2),'=A2');
    const other=createHost({rows:1}); other.load('formula/formula_sheet.js');
    p.plan.actions[0].target_range='A2';
    await assert.rejects(()=>other.window.formulaSheet.prepareFormulaPreview(p,other.selection),/원본 선택 범위/);
    assert.equal(other.writes.length,0);
});

test('single-result relocation preserves planned row count within a larger input selection',async()=>{
    const h=createHost({rows:90000});h.load('formula/formula_sheet.js');
    const p={plan:{actions:[{target_range:'C2',anchor_cell:'C2',formula:'=SUM(A2:A90001)',mode:'single'}]}};
    h.occupied.set('1,2',{value:'occupied'});
    const automatic=await h.window.formulaSheet.prepareFormulaPreview(p,h.selection);
    assert.equal(automatic.target_range,'D2');assert.equal(automatic.row_count,1);
    h.selected=h.range(0,4,1,1);
    const manual=await h.window.formulaSheet.readFormulaTarget(p,h.selection);
    assert.equal(manual.target_range,'E2');assert.equal(manual.row_count,1);
    p.plan.actions[0].target_range='E2';p.plan.actions[0].anchor_cell='E2';
    const result=await h.window.formulaSheet.applyFormulaPreview(p,h.selection);
    assert.equal(result.row_count,1);assert.equal(h.formulaAt(2,4),'');
});


test('table automatic calculated-column fill completes all 3092 rows without rewriting later batches',async()=>{
    const h=createHost({rows:3092,tableColumns:['상호','참고','분석대상여부'],autoFillTable:true});
    h.load('formula/formula_sheet.js');
    const p=plan(3092);p.plan.actions[0].formula='=IF(A2="JIANGSU SHAGANG INTL TRADE","Y","N")';
    const progress=[];
    const result=await h.window.formulaSheet.applyFormulaPreview(p,h.selection,(phase,done,total)=>progress.push({done,total}));
    assert.equal(result.row_count,3092);assert.deepEqual(progress.at(-1),{done:3092,total:3092});
    assert(h.writes.some(w=>w.autoFilled));
    assert.equal(h.writes.filter(w=>w.r>=1001).length,0,'already correct formulas must not be overwritten');
    assert.equal(h.calculatedFormulaAt(3092,2),'=IF(A3093="JIANGSU SHAGANG INTL TRADE","Y","N")');
    assert(h.loads.filter(x=>['formulasR1C1','valueTypes'].includes(x.properties)).every(x=>x.n<=1000));
});
test('autofilled formulas preserve mixed references and complete dependent columns in order',async()=>{
    const h=createHost({rows:3092,tableColumns:['A','B','C','D'],autoFillTable:true});h.load('formula/formula_sheet.js');
    const result=await h.window.formulaSheet.applyFormulaPreview(plan(3092,['C','D']),h.selection);
    assert.equal(result.action_count,2);
    assert.equal(h.calculatedFormulaAt(3092,2),translate('=A2+$B$2+A$1+$B2',3091,0));
    assert.equal(h.calculatedFormulaAt(3092,3),'=C3093+1');
});
test('constants and differing formulas after table autofill still stop without overwriting them',async()=>{
    for(const cell of [{value:'manual'},{formula:'=A1002+99'},{formula:'=""'}, {value:'Y'}]) {
        const h=createHost({rows:3092,tableColumns:['A','B','C'],autoFillTable:true});h.load('formula/formula_sheet.js');
        h.beforeSync=()=>{if(h.writes.length)h.occupied.set('1001,2',cell);};
        await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/1000셀.*기존 값/);
        assert.equal(h.writes.filter(w=>w.r>=1001).length,0);
        assert.deepEqual(h.occupied.get('1001,2'),cell);
    }
});
test('an edited anchor cannot silently change subsequent batch formulas',async()=>{
    const h=createHost({rows:3092});h.load('formula/formula_sheet.js');
    h.beforeSync=()=>{if(h.writes.length)h.occupied.set('1,2',{formula:'=A2+99'});};
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/기준 수식.*바뀌/);
    assert.equal(h.writes.filter(w=>w.r>=1001).length,0);
});
test('calculation errors in an automatically filled later batch are checked and reported',async()=>{
    const h=createHost({rows:3092,tableColumns:['A','B','C'],autoFillTable:true});h.load('formula/formula_sheet.js');h.errorRow=1001;
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/1000셀.*C1002:C2001.*Excel 오류/);
});
test('preexisting identical formulas are never treated as autofill from this execution',async()=>{
    const h=createHost({rows:3092,tableColumns:['A','B','C'],autoFillTable:true});h.load('formula/formula_sheet.js');
    h.occupied.set('1001,2',{formula:translate('=A2+$B$2+A$1+$B2',1000,0)});
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/결과 범위가 바뀌/);
    assert.equal(h.writes.length,0);
});

test('3092 calculated table results become editable typed values, including formula-looking text',async()=>{
    const values=['Y','N','',42.5,true,'=literal','+literal','-literal','0012'];
    const h=createHost({rows:3092,tableColumns:['상호','참고','판단'],autoFillTable:true,
        calculateValue:r=>values[(r-1)%values.length]});h.load('formula/formula_sheet.js');
    const updates=[];await h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection,
        (phase,done,total)=>updates.push({phase,done,total}));
    for(let r=1;r<=3092;r++) {
        assert.equal(h.formulaAt(r,2),'');assert.equal(h.valueAt(r,2),values[(r-1)%values.length]);
    }
    assert.deepEqual(updates.at(-1),{phase:'결과값 저장',done:3092,total:3092});
    assert.equal(h.formulaAt(0,2),'');assert.equal(h.valueCopies.reduce((n,p)=>n+p.n,0),3092);
    assert(h.valueCopies.every(p=>p.n<=1000));
});
test('dependent outputs calculate before value conversion and keep their values after inputs change',async()=>{
    let input=7;
    const h=createHost({rows:1001,calculateValue:(r,c,formula,valueAt)=>c===2?input:valueAt(r,2)+1});
    h.load('formula/formula_sheet.js');
    let firstFreezeWrites;
    h.beforeSync=()=>{if(h.valueCopies.length && firstFreezeWrites===undefined)firstFreezeWrites=h.writes.length;};
    await h.window.formulaSheet.applyFormulaPreview(plan(1001,['C','D']),h.selection);
    assert.equal(firstFreezeWrites,h.writes.length,'all formula writes must precede freezing');
    input=99;
    for(const r of [1,1001]) {
        assert.equal(h.valueAt(r,2),7);assert.equal(h.valueAt(r,3),8);
        assert.equal(h.formulaAt(r,2),'');assert.equal(h.formulaAt(r,3),'');
    }
});
test('calculation failure does not start value conversion',async()=>{
    const h=createHost({rows:3092});h.load('formula/formula_sheet.js');h.errorRow=2001;
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/Excel 오류/);
    assert.equal(h.valueCopies.length,0);
});
test('manual edits between calculation and freezing are not overwritten',async()=>{
    for(const cell of [{value:'manual'}, {formula:'=A2+99'}]) {
        const h=createHost({rows:1001});h.load('formula/formula_sheet.js');
        await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(1001),h.selection,(phase,done,total)=>{
            if(phase==='수식 계산 확인' && done===total)h.occupied.set('1,2',cell);
        }),/셀 값이 바뀌/);
        assert.equal(h.valueCopies.length,0);assert.deepEqual(h.occupied.get('1,2'),cell);
    }
});
test('failed value paste reports saved count and does not return successful completion',async()=>{
    const h=createHost({rows:3092});h.load('formula/formula_sheet.js');h.failValueCopy=2;
    await assert.rejects(()=>h.window.formulaSheet.applyFormulaPreview(plan(3092),h.selection),/값 저장 완료 1000셀.*C1002:C2001.*value paste failed/);
    assert.equal(h.formulaAt(1,2),'');assert.notEqual(h.formulaAt(1001,2),'');
});
test('formula UI explains fixed values before approval and reports value completion',()=>{
    const {createDOM}=require('../helpers/taskpane_dom.cjs'),h=createDOM();h.load('formula/formula_ui.js');
    const chat={enterConversation(){},conversation:h.document.getElementById('conversation'),scrollArea:h.document.getElementById('scroll-area')};
    // reset only needs an append target; the production chat supplies its scroll area.
    chat.scrollArea=chat.conversation;
    const ui=h.window.createFormulaUI(chat);ui.reset();
    assert.equal(h.document.getElementById('formula-apply').textContent,'확인 후 결과값 저장');
    ui.showPreview('계산', {address:'A2:A4'}, {plan:{actions:[{output_label:'값',target_range:'B2:B4',formula:'=A2'}],summary:'계산'}},
        {address:'B2:B4',row_count:3,reason:'planned'});
    assert.match(h.document.getElementById('formula-preview').textContent,/결과값만 저장.*자동 재계산되지/);
    ui.setApplied({address:'B2:B4',row_count:3});
    assert.match(h.document.getElementById('formula-status').textContent,/값으로 저장/);
});

test('frozen Y/N results can be passed to existing-column conditional edits',async()=>{
    const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
    const h=createHost({rows:3,calculateValue:r=>r===1?'Y':'N'});h.load('formula/formula_sheet.js');
    await h.window.formulaSheet.applyFormulaPreview(plan(3),h.selection);
    const excel=createInvestigationHost(),f=excel.workspace(['id','회사','분석대상여부'],
        ['JIANGSU SHAGANG INTL','OTHER','JIANGSU SHAGANG CO'].map((name,i)=>[i+1,name,h.valueAt(i+1,2)]));
    assert([1,2,3].every(r=>h.formulaAt(r,2)===''));
    f.work.row_filter={column_id:f.work.columns[0].column_id,operator:'contains',value:'JIANGSU SHAGANG'};
    const destination=f.work.columns[1].column_id;
    const snapshot=await excel.window.operationsSheet.read(f.work,f.target,[f.work.columns[0].column_id],()=>{},()=>{},destination);
    await excel.window.operationsSheet.write(snapshot,snapshot.rows.map(()=>['Y']),['분석대상여부'],{mode:'existing',column_id:destination},()=>{});
    assert.deepEqual(f.sheet.cells.slice(1).map(row=>row[2]),['Y','N','Y']);
});
