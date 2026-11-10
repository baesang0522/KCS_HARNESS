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
        assert(h.writes.every(x=>x.n<=1000));
        assert(h.loads.filter(x=>x.properties==='valueTypes').every(x=>x.n<=1000));
        for (const r of [1,1000,1001,count]) {
            assert.equal(h.formulaAt(r,2),translate('=A2+$B$2+A$1+$B2',r-1,0));
            assert.equal(h.formulaAt(r,3),`=C${r+1}+1`);
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
    assert.equal(h.formulaAt(1,2),'=A2');
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
