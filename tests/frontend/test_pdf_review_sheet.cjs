const test=require('node:test'),assert=require('node:assert/strict');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
const row=(name='Baoshan Iron & Steel Co., Ltd.',group='01')=>({target:{kind:'supplier',group,category:'제조사',company_name:name},source_pages:[1]});
function setup(){const h=createInvestigationHost();let serial=0;h.window.apiClient={newRequestId:()=>String(++serial).padStart(12,'0')};h.load('documents/review_sheet.js');h.review=h.window.investigationSheet;return h;}
const plain=value=>JSON.parse(JSON.stringify(value));
test('supplier review sheet has only four visible columns, literal text and no row-ID columns',async()=>{
    const h=setup(),source=h.addSheet('원본',[['회사'],['보존']]);
    await h.review.ensure('chat','doc','해외.pdf',[row()]);const sheet=h.sheets[1];
    assert.deepEqual(plain(sheet.cells[3]),['그룹','구분','회사명','근거 페이지']);
    assert.equal(sheet.cells[4][0],'01');assert.equal(sheet.formats[4][0],'@');
    assert.deepEqual(plain((await h.review.read('chat','doc')).rows),[row()]);
    assert.deepEqual(source.cells,[['회사'],['보존']]);assert.equal(h.writes.some(w=>w.sheet===source.id),false);
    const writes=h.writes.length;sheet.cells[4][2]='사용자 변경';
    await h.review.ensure('chat','doc','해외.pdf',[row()]);assert.equal(h.writes.length,writes);assert.equal(sheet.cells[4][2],'사용자 변경');
});
test('sort, insert and delete are reflected by row contents; metadata never tracks row positions',async()=>{
    const h=setup();await h.review.ensure('chat','doc','해외.pdf',[row('A','1'),row('B','2')]);
    const sheet=h.sheets[0],table=sheet.tables.items[0];[sheet.cells[4],sheet.cells[5]]=[sheet.cells[5],sheet.cells[4]];
    sheet.cells.push(['3','관계 수출사','한글 Export','1, 2']);table.count++;
    const draft=await h.review.read('chat','doc');assert.deepEqual(plain(draft.rows.map(r=>[r.target.group,r.target.company_name])),[['2','B'],['1','A'],['3','한글 Export']]);
    sheet.cells.splice(5,1);table.count--;assert.deepEqual(plain((await h.review.read('chat','doc')).rows.map(r=>r.target.company_name)),['B','한글 Export']);
    await h.review.markSaved('chat','doc',(await h.review.read('chat','doc')).rows);
    assert.equal(h.review.canonical((await h.review.read('chat','doc')).baseline),h.review.canonical((await h.review.read('chat','doc')).rows));
});
test('item alternatives retain HS OR and specification-specific thickness conditions',async()=>{
    const h=setup(),rows=[{target:{kind:'item',group:'1',hs_codes:['7208511000','7208519000'],specification:'SA516-70',requirements:'두께 134mm 이상'},source_pages:[1]},
        {target:{kind:'item',group:'2',hs_codes:['7208511000','7208519000'],specification:'SA302 Grade C',requirements:''},source_pages:[1]}];
    await h.review.ensure('c','d','품목.pdf',rows);assert.equal(h.sheets[0].cells[3].length,5);
    assert.deepEqual(plain((await h.review.read('c','d')).rows),rows);
    assert.throws(()=>h.review.parse('item',[['1','','','','1']]),/HS/);
});
test('renamed headers, missing tables, formula cells, oversized reviews and malformed pages reject before save',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);const s=h.sheets[0],t=s.tables.items[0];
    s.cells[3][0]='바꾼 열';await assert.rejects(h.review.read('c','d'),/열 이름/);s.cells[3][0]='그룹';
    s.cells[4][2]='=NOW()';await assert.rejects(h.review.read('c','d'),/수식/);s.cells[4][2]='회사';
    s.cells[4][3]='1쪽';await assert.rejects(h.review.read('c','d'),/근거 페이지/);s.cells[4][3]='1';
    t.count=101;await assert.rejects(h.review.read('c','d'),/100행/);t.count=1;
    s.tables.items=[];await assert.rejects(h.review.read('c','d'),/table not found/);
});
test('empty rows mean deletion, manual rows allow blank evidence, different chats do not reuse sheets',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);h.sheets[0].cells[4]=['','','',''];
    assert.deepEqual(plain((await h.review.read('c','d')).rows),[]);
    h.sheets[0].tables.items[0].count=0;
    assert.deepEqual(plain((await h.review.read('c','d')).rows),[]);
    assert.deepEqual(plain(h.review.parse('supplier',[['1','기타','추가 회사','']])[0].source_pages),[]);
    assert.equal(await h.review.read('other','d'),null);
    assert.throws(()=>h.review.parse('supplier',[['1','','추가 회사','']]),/구분/);
});
test('snapshot conflicts and partial write errors preserve all existing sheets',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);
    await assert.rejects(h.review.ensure('c','d','파일.pdf',[row('다른 서버값')]),/기존 검토 시트/);
    const before=structuredClone(h.sheets[0].cells);let count=0;h.beforeSync=()=>{if(++count===2)throw Error('Excel 실패');};
    await assert.rejects(h.review.ensure('c','new','새 파일.pdf',[row()]),/작성이 완료되지/);
    assert.deepEqual(h.sheets[0].cells,before);
});

test('preprocess writes only the bound review column and leaves server-reflection baseline untouched',async()=>{
    const h=setup(),original=h.addSheet('원본',[['회사명'],['원본 보존']]);
    await h.review.ensure('c','d','해외.pdf',[row('회사(ACME)'),row('관계사(BETA)')]);
    const targets=await h.review.preprocessTargets('c','d');assert.equal(targets.length,4);
    const target=targets.find(t=>t.column_index===2),snapshot=await h.review.readPreprocess('c','d',target);
    original.activate();const writes=h.writes.length;
    await h.review.writePreprocess('c','d',snapshot,['(ACME)','(BETA)']);
    const changes=h.writes.slice(writes);assert.equal(changes.length,1);assert.equal(changes[0].c,2);assert.equal(changes[0].m,1);
    assert.equal(changes[0].sheet,snapshot.worksheet_id);assert.deepEqual(original.cells,[['회사명'],['원본 보존']]);
    const draft=await h.review.read('c','d');assert.equal(draft.rows[0].target.company_name,'(ACME)');
    assert.equal(draft.baseline[0].target.company_name,'회사(ACME)');assert.notEqual(h.review.canonical(draft.rows),h.review.canonical(draft.baseline));
    assert.deepEqual(plain(h.sheets[1].cells[4]),['01','제조사','(ACME)','1']);
});
test('preprocess rejects other documents, changed rows, row sorting and bad result shapes before writes',async()=>{
    const h=setup();await h.review.ensure('c','d','해외.pdf',[row('회사A','1'),row('회사B','2')]);
    const target=(await h.review.preprocessTargets('c','d'))[2],snapshot=await h.review.readPreprocess('c','d',target),sheet=h.sheets[0];
    await assert.rejects(h.review.readPreprocess('c','other',target),/이 PDF/);
    await assert.rejects(h.review.writePreprocess('c','d',snapshot,['A']),/행 수/);
    const count=h.writes.length;sheet.cells[4][0]='사용자 그룹 수정';
    await assert.rejects(h.review.writePreprocess('c','d',snapshot,['A','B']),/미리보기 이후/);
    sheet.cells[4][0]='1';[sheet.cells[4],sheet.cells[5]]=[sheet.cells[5],sheet.cells[4]];
    await assert.rejects(h.review.writePreprocess('c','d',snapshot,['A','B']),/미리보기 이후/);
    assert.equal(h.writes.length,count);
});
test('preprocess writes values as literal text and reports uncertainty after a write failure',async()=>{
    const h=setup();await h.review.ensure('c','d','해외.pdf',[row('한글=1+1')]);
    const target=(await h.review.preprocessTargets('c','d'))[2],snapshot=await h.review.readPreprocess('c','d',target);
    await h.review.writePreprocess('c','d',snapshot,['=1+1']);assert.equal(h.sheets[0].cells[4][2],'=1+1');assert.equal(h.sheets[0].formats[4][2],'@');
    h.sheets[0].cells[4][2]='한글=1+1';h.sheets[0].protected=true;
    await assert.rejects(h.review.writePreprocess('c','d',snapshot,['=1+1']),/완료했는지 확인하지 못/);
});
