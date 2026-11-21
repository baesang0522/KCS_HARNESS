const test=require('node:test'),assert=require('node:assert/strict');
const {createHost}=require('../helpers/excel_mock.cjs');
function setup(){
 const h=createHost({rows:3,sourceColumns:1});h.load('formula/formula_sheet.js');
 const source=h.context.workbook.worksheets.getItem('sheet');
 function reference(id,name){
  const sheet={id,name,rows:102,headers:['그룹명','회사명','근거 페이지'],company:'ACME',load(){}};
  const address=(r,c,n,m)=>"'"+sheet.name+"'!"+String.fromCharCode(65+c)+(r+1)+':'+String.fromCharCode(64+c+m)+(r+n);
  function range(r,c,n,m){
   return {rowIndex:r,columnIndex:c,rowCount:n,columnCount:m,address:address(r,c,n,m),load(){
    this.text=Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>r+i===0?'원문.pdf':r+i===1?sheet.headers[c+j]:c+j===1?sheet.company:'그룹'));
    this.values=this.text;
   },getCell:(dr,dc)=>range(r+dr,c+dc,1,1),getResizedRange:(dr,dc)=>range(r,c,n+dr,m+dc)};
  }
  sheet.getUsedRange=()=>range(0,0,sheet.rows,3);
  sheet.tables={load(){},items:[{id:'table-'+id,getRange:()=>range(1,0,sheet.rows-1,3),
   getHeaderRowRange:()=>range(1,0,1,3),getDataBodyRange:()=>range(2,0,sheet.rows-2,3)}]};
  return sheet;
 }
 const ref=reference('reference','거래처검토_ref');
 h.context.workbook.worksheets={items:[source,ref],load(){},getItem(id){const value=this.items.find(s=>s.id===id||s.name===id);if(!value)throw Error('삭제된 시트');return value;}};
 return {h,ref,reference,sheets:h.context.workbook.worksheets};
}
const plan={plan:{actions:[{target_range:'B2:B4',anchor_cell:'B2',formula:'=IF(COUNTIF(\'거래처검토_ref\'!$B$3:$B$102,A2)>0,"Y","N")',mode:'fill_down'}]}};

test('named reference resolves actual suffixed sheet and full table headers without writes',async()=>{
 const {h}=setup(),selection=await h.window.formulaSheet.readFormulaContext(null,['거래처검토']);
 const ref=selection.reference_sheets[0];
 assert.equal(ref.sheet_name,'거래처검토_ref');assert.equal(ref.tables[0].headers[1],'회사명');
 assert.equal(ref.tables[0].data_address,"'거래처검토_ref'!A3:C102");assert.equal(ref.samples.length,20);
 assert.equal(h.writes.length,0);
 await h.window.formulaSheet.applyFormulaPreview(plan,selection);
 assert.equal(h.calculatedFormulaAt(3,1),'=IF(COUNTIF(\'거래처검토_ref\'!$B$3:$B$102,A4)>0,"Y","N")');
});
test('ambiguous reference names ask for sheet names; exact names win and unrequested sheets stay unread',async()=>{
 const {h,sheets,reference}=setup();sheets.items.push(reference('second','거래처검토_second'));
 await assert.rejects(()=>h.window.formulaSheet.readFormulaContext(null,['거래처검토']),/거래처검토_ref.*거래처검토_second/);
 sheets.items[2].getUsedRange=()=>{throw Error('unrequested read')};
 const selection=await h.window.formulaSheet.readFormulaContext(null,['거래처검토_ref']);assert.equal(selection.reference_sheets.length,1);
 await assert.rejects(()=>h.window.formulaSheet.readFormulaContext(null,['없는시트']),/시트 이름/);
 assert.equal(h.writes.length,0);
});
test('reference rename, row growth, moved headers and deletion block approval before writes',async()=>{
 for(const change of [f=>f.ref.name='다른이름',f=>f.ref.rows++,f=>f.ref.headers.reverse(),f=>f.sheets.items.pop()]){
  const f=setup(),selection=await f.h.window.formulaSheet.readFormulaContext(null,['거래처검토']);change(f);
  await assert.rejects(()=>f.h.window.formulaSheet.applyFormulaPreview(plan,selection),/참조 시트|삭제된 시트/);
  assert.equal(f.h.writes.length,0);
 }
});
test('formula uses current reference values while requiring the reviewed table layout',async()=>{
 const {h,ref}=setup(),selection=await h.window.formulaSheet.readFormulaContext(null,['거래처검토']);
 ref.company='NEW VALUE';await h.window.formulaSheet.validateFormulaPreview(plan,selection);
 assert.equal(h.writes.length,0);
});
