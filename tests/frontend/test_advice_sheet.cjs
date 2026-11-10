const test=require('node:test');
const assert=require('node:assert/strict');
const {createHost}=require('../helpers/excel_mock.cjs');
const columns=[{column_id:'1',role:'declared_name'},{column_id:'2',role:'trade_name'},
    {column_id:'3',role:'model_spec'},{column_id:'4',role:'reference'},{column_id:'5',role:'reference'}];
const ids=['5','3','2','1','4'];
function setup(rows=400000) {
    const h=createHost({rows,tableColumns:['identity','신고품명','거래품명','모델규격명','설명','수량'],
        data:(r,c)=> {
            const key=r>rows-1000?501:(r-1)%502;
            return [r,r%2?'paint':'PAINT',r%2?'enamel':'ENAMEL',`ab${key}`,`note${r}`,String(r)][c];
        }});
    h.load('workspace/table_reader.js');h.load('operations/operations_sheet.js');h.load('recommendation/recommendation_sheet.js');
    const workspace={worksheet_id:'sheet',table_id:'table',source_row_column_id:'0',columns};
    h.workspace=workspace;
    h.target=async()=>{
        // layout is also used by the real workspace controller before reading.
        let info;
        const fakeContext={workbook:{worksheets:{getItem:()=>h.range(1,0,1,1).worksheet}},sync:async()=>{}};
        info=await h.window.workspaceTable.layout(fakeContext,workspace);
        return {row_start:1,row_count:rows,stamp:info.stamp};
    };
    return h;
}
test('400k rows aggregate across the whole table, sending only top100 and first-row extras',async()=>{
    const h=setup(); const progress=[];
    const result=await h.window.recommendationSheet.readModelAdvice(h.workspace,await h.target(),ids,
        (label,done,total)=>progress.push({label,done,total}),()=>{});
    assert.equal(result.rows.length,100);
    assert.equal(result.selection.total_rows,400000);
    assert.equal(result.selection.total_combinations,502);
    const counts=new Map();
    for(let r=1;r<=400000;r++) {
        const key=r>399000?501:(r-1)%502;
        if(!counts.has(key))counts.set(key,{count:0,first:r});
        counts.get(key).count++;
    }
    const expected=[...counts].sort((a,b)=>b[1].count-a[1].count||a[1].first-b[1].first).slice(0,100);
    expected.forEach(([key,item],i)=>{
        assert.equal(result.rows[i].values[1],`AB${key}`);
        assert.equal(result.rows[i].count,item.count);
        assert.equal(result.rows[i].excel_row,item.first+1);
        assert.equal(result.rows[i].values[4],`NOTE${item.first}`);
    });
    assert.equal(result.rows[0].values[1],'AB501');
    assert.equal(result.selection.represented_rows,expected.reduce((sum,x)=>sum+x[1].count,0));
    assert(h.loads.filter(x=>x.properties==='text'&&x.n>1).every(x=>[1,2,3].includes(x.c)&&x.n<=1000));
    assert.equal(h.writes.length,0);
    assert(progress.some(x=>x.label==='전체 조합 빈도 집계'&&x.done===400000));
});
test('cancellation stops scanning without producing a partial summary',async()=>{
    const h=setup();let checks=0;
    await assert.rejects(()=>h.window.recommendationSheet.readModelAdvice(h.workspace,{row_start:1,row_count:400000,
        stamp:JSON.stringify([1,0,400000,['identity','신고품명','거래품명','모델규격명','설명','수량'].map((header,i)=>({column_id:String(i),header,column_index:i}))])},ids,
        ()=>{},()=>{if(++checks===3)throw new Error('stopped');}),/stopped/);
    assert(h.loads.filter(x=>x.properties==='text').every(x=>x.r<3000));
});
test('missing grouping role fails before scanning',async()=>{
    const h=setup(10);h.workspace.columns=columns.filter(c=>c.role!=='trade_name');
    await assert.rejects(async()=>h.window.recommendationSheet.readModelAdvice(h.workspace,await h.target(),ids,()=>{},()=>{}),/빈도 집계/);
});
