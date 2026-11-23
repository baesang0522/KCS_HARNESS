const test=require('node:test'),assert=require('node:assert/strict');
const {createInvestigationHost}=require('../helpers/investigation_host.cjs');
const row=(name='Baoshan Iron & Steel Co., Ltd.',group='01')=>({target:{kind:'supplier',group,category:'바오 스틸',company_name:name},source_pages:[1]});
function setup(){const h=createInvestigationHost();let serial=0;h.window.apiClient={newRequestId:()=>String(++serial).padStart(12,'0')};h.load('documents/review_sheet.js');h.review=h.window.investigationSheet;return h;}
const plain=value=>JSON.parse(JSON.stringify(value));
test('supplier review sheet has only three visible columns, literal text and no row-ID columns',async()=>{
    const h=setup(),source=h.addSheet('원본',[['회사'],['보존']]);
    await h.review.ensure('chat','doc','해외.pdf',[row()]);const sheet=h.sheets[1];
    assert.deepEqual(plain(sheet.cells[3]),['그룹명','회사명','근거 페이지']);
    assert.equal(sheet.cells[4][0],'바오 스틸');assert.equal(sheet.formats[4][0],'@');
    assert.deepEqual(plain((await h.review.read('chat','doc')).rows),[row()]);
    assert.deepEqual(source.cells,[['회사'],['보존']]);assert.equal(h.writes.some(w=>w.sheet===source.id),false);
    assert.equal(await h.review.isReady('chat','doc',[row()]),true);
    assert.equal(await h.review.isReady('chat','missing',[row()]),false);
    assert.equal(await h.review.isReady('chat','doc',[{target:{kind:'item'}}]),false);
    const writes=h.writes.length;sheet.cells[4][1]='사용자 변경';
    await h.review.ensure('chat','doc','해외.pdf',[row()]);assert.equal(h.writes.length,writes);assert.equal(sheet.cells[4][1],'사용자 변경');
});
test('sort, insert and delete are reflected by row contents; metadata never tracks row positions',async()=>{
    const h=setup();await h.review.ensure('chat','doc','해외.pdf',[row('A','1'),row('B','2')]);
    const sheet=h.sheets[0],table=sheet.tables.items[0];[sheet.cells[4],sheet.cells[5]]=[sheet.cells[5],sheet.cells[4]];
    sheet.cells.push(['추가회사','한글 Export','1, 2']);table.count++;
    const draft=await h.review.read('chat','doc');assert.deepEqual(plain(draft.rows.map(r=>[r.target.group,r.target.company_name])),[['2','B'],['1','A'],['추가회사','한글 Export']]);
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
test('renamed headers, missing tables, formula cells and malformed pages reject before save',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);const s=h.sheets[0],t=s.tables.items[0];
    s.cells[3][0]='바꾼 열';await assert.rejects(h.review.read('c','d'),/열 이름/);s.cells[3][0]='그룹명';
    s.cells[4][1]='=NOW()';await assert.rejects(h.review.read('c','d'),/수식/);s.cells[4][1]='회사';
    s.cells[4][2]='1쪽';await assert.rejects(h.review.read('c','d'),/근거 페이지/);s.cells[4][2]='1';
    s.tables.items=[];await assert.rejects(h.review.read('c','d'),/table not found/);
});
test('empty rows mean deletion, manual rows allow blank evidence, different chats do not reuse sheets',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);h.sheets[0].cells[4]=['','',''];
    assert.deepEqual(plain((await h.review.read('c','d')).rows),[]);
    h.sheets[0].tables.items[0].count=0;
    assert.deepEqual(plain((await h.review.read('c','d')).rows),[]);
    assert.deepEqual(plain(h.review.parse('supplier',[['기타','추가 회사','']])[0].source_pages),[]);
    assert.equal(await h.review.read('other','d'),null);
    assert.equal(h.review.parse('supplier',[['English Only Co.','English Only Co.','']])[0].target.category,'English Only Co.');
    assert.throws(()=>h.review.parse('supplier',[['한글명','','']]),/회사명/);
});
test('snapshot conflicts and partial write errors preserve all existing sheets',async()=>{
    const h=setup();await h.review.ensure('c','d','파일.pdf',[row()]);
    await assert.rejects(h.review.ensure('c','d','파일.pdf',[row('다른 서버값')]),/기존 검토 시트/);
    const before=structuredClone(h.sheets[0].cells);h.beforeSync=()=>{if(h.sheets.length>1)throw Error('Excel 실패');};
    await assert.rejects(h.review.ensure('c','new','새 파일.pdf',[row()]),/작성이 완료되지/);
    assert.deepEqual(h.sheets[0].cells,before);
});

test('preprocess writes only the bound review column and leaves server-reflection baseline untouched',async()=>{
    const h=setup(),original=h.addSheet('원본',[['회사명'],['원본 보존']]);
    await h.review.ensure('c','d','해외.pdf',[row('회사(ACME)'),row('관계사(BETA)')]);
    const targets=await h.review.preprocessTargets('c','d');assert.equal(targets.length,3);
    const target=targets.find(t=>t.column_index===1),snapshot=await h.review.readPreprocess('c','d',target);
    original.activate();const writes=h.writes.length;
    await h.review.writePreprocess('c','d',snapshot,['(ACME)','(BETA)']);
    const changes=h.writes.slice(writes);assert.equal(changes.length,1);assert.equal(changes[0].c,1);assert.equal(changes[0].m,1);
    assert.equal(changes[0].sheet,snapshot.worksheet_id);assert.deepEqual(original.cells,[['회사명'],['원본 보존']]);
    const draft=await h.review.read('c','d');assert.equal(draft.rows[0].target.company_name,'(ACME)');
    assert.equal(draft.baseline[0].target.company_name,'회사(ACME)');assert.notEqual(h.review.canonical(draft.rows),h.review.canonical(draft.baseline));
    assert.deepEqual(plain(h.sheets[1].cells[4]),['바오 스틸','(ACME)','1']);
});
test('preprocess rejects other documents, changed rows, row sorting and bad result shapes before writes',async()=>{
    const h=setup();await h.review.ensure('c','d','해외.pdf',[row('회사A','1'),row('회사B','2')]);
    const target=(await h.review.preprocessTargets('c','d'))[1],snapshot=await h.review.readPreprocess('c','d',target),sheet=h.sheets[0];
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
    const target=(await h.review.preprocessTargets('c','d'))[1],snapshot=await h.review.readPreprocess('c','d',target);
    await h.review.writePreprocess('c','d',snapshot,['=1+1']);assert.equal(h.sheets[0].cells[4][1],'=1+1');assert.equal(h.sheets[0].formats[4][1],'@');
    h.sheets[0].cells[4][1]='한글=1+1';h.sheets[0].protected=true;
    await assert.rejects(h.review.writePreprocess('c','d',snapshot,['=1+1']),/완료했는지 확인하지 못/);
});

test('236 review rows survive Excel creation, edits, preprocessing and saved baseline without a 100-row cap',async()=>{
    const h=setup(),rows=Array.from({length:236},(_,i)=>row('MODEL-'+i));
    await h.review.ensure('chat','large','모델명.pdf',rows);
    const s=h.sheets[0];assert.equal(s.tables.items[0].count,236);s.cells[239][1]='last edited';
    const draft=await h.review.read('chat','large');assert.equal(draft.rows.length,236);assert.equal(draft.rows[235].target.company_name,'last edited');
    const target=(await h.review.preprocessTargets('chat','large'))[1],snapshot=await h.review.readPreprocess('chat','large',target);
    await h.review.writePreprocess('chat','large',snapshot,snapshot.values.map(r=>r[1].toUpperCase()));
    const saved=await h.review.read('chat','large');await h.review.markSaved('chat','large',saved.rows);
    assert.equal((await h.review.read('chat','large')).baseline.length,236);assert.equal(s.cells[239][1],'LAST EDITED');
});

test('legacy four-column sheets remain readable and preprocess their actual company column',async()=>{
 const h=setup();await h.review.ensure('chat','doc','파일.pdf',[row()]);const sheet=h.sheets[0],table=sheet.tables.items[0];
 sheet.cells[3]=['그룹','구분','회사명','근거 페이지'];sheet.cells[4]=['01','바오 스틸','Baoshan Iron & Steel Co., Ltd.','1'];
 table.columns.items.push({...table.columns.items[2],name:'근거 페이지',id:'legacy-page'});
 assert.deepEqual(plain((await h.review.read('chat','doc')).rows),[row()]);
 const targets=await h.review.preprocessTargets('chat','doc');assert.equal(targets[2].label,'회사명');
 const snapshot=await h.review.readPreprocess('chat','doc',targets[2]);await h.review.writePreprocess('chat','doc',snapshot,['EDITED']);
 assert.equal((await h.review.read('chat','doc')).rows[0].target.company_name,'EDITED');
});
test('duplicate display names preserve original evidence groups; supplier order affects tie-breaking',async()=>{
 const h=setup(),rows=[row('A','1'),row('A','2'),row('B','3')];await h.review.ensure('c','d','파일.pdf',rows);
 assert.deepEqual(plain((await h.review.read('c','d')).rows),rows);
 const reordered=[rows[2],rows[0],rows[1]];assert.notEqual(h.review.canonical(rows),h.review.canonical(reordered));
 assert.equal(h.sheets[0].cells[3].length,3);assert.equal(h.sheets[0].cells[4][0],'바오 스틸');
});

test('original numeric groups stay in workbook evidence after visible names are edited and saved',async()=>{
 const h=setup(),original=[row('BAOSHAN','1')];await h.review.ensure('c','d','파일.pdf',original);
 h.sheets[0].cells[4][0]='수정한 그룹명';h.sheets[0].cells[4][1]='EDITED';
 const draft=await h.review.read('c','d');await h.review.markSaved('c','d',draft.rows);
 const meta=await h.review.ensure('c','d','파일.pdf',draft.rows);
 assert.deepEqual(plain(meta.original_rows),original);assert.equal(meta.original_rows[0].target.group,'1');
 assert.equal(h.sheets[0].cells[3].length,3);assert.equal(meta.baseline[0].target.category,'수정한 그룹명');
});
test('new review sheets use normalized PDF basenames with consecutive collision suffixes',async()=>{
 const h=setup();h.addSheet('해외거래처',[['기존 자료']]);
 await h.review.ensure('c','a','해외거래처.pdf',[row()]);
 await h.review.ensure('c','b','해외거래처.PDF',[row()]);
 await h.review.ensure('c','c','품목.pdf',[row()]);
 assert.deepEqual(h.sheets.map(s=>s.name),['해외거래처','해외거래처 1','해외거래처 2','품목']);
 const writes=h.writes.length;h.sheets[1].name='사용자가 정한 이름';h.sheets[1].cells[4][1]='수동 수정';
 await h.review.ensure('c','a','해외거래처.pdf',[row()]);
 assert.equal(h.writes.length,writes);assert.equal(h.sheets[1].name,'사용자가 정한 이름');assert.equal(h.sheets[1].cells[4][1],'수동 수정');
 const x=setup();x.addSheet('ACME',[['보존']]);await x.review.ensure('c','d','acme.pdf',[row()]);assert.equal(x.sheets[1].name,'acme 1');
});
test('PDF names fit Excel naming rules and mixed document tables remain separate',async()=>{
 const h=setup(),long='아주긴파일이름'.repeat(8);
 await h.review.ensure('c','a',long+'.pdf',[row()]);await h.review.ensure('c','b',long+'.pdf',[row()]);
 assert.deepEqual(h.sheets.map(s=>s.name),['거래처검토','거래처검토 1']);
 await h.review.ensure('c','d',"'가/나'.pdf",[row()]);assert.equal(h.sheets[2].name,'가_나');
 await h.review.ensure('c','e','History.pdf',[row()]);assert.equal(h.sheets[3].name,'거래처검토 2');
 const item={target:{kind:'item',group:'규격',hs_codes:[],specification:'A',requirements:''},source_pages:[1]};
 await h.review.ensure('c','f','혼합.pdf',[row(),item]);assert.deepEqual(h.sheets.slice(4).map(s=>s.name),['혼합','혼합 1']);
 assert.equal((await h.review.read('c','f')).rows.length,2);
});
test('five-character basenames stay literal and longer names use the review kind',async()=>{
 const h=setup(),item={target:{kind:'item',group:'규격',hs_codes:[],specification:'A',requirements:''},source_pages:[1]};
 await h.review.ensure('c','a','가나다라마.PDF',[row()]);
 await h.review.ensure('c','b','가나다라마바.pdf',[row(),item]);
 await h.review.ensure('c','c','설명자료긴이름.pdf',[]);
 await h.review.ensure('c','d','abcde.pdf',[row()]);
 await h.review.ensure('c','e','abcdef.pdf',[row()]);
 await h.review.ensure('c','f','😀가나다라.pdf',[row()]);
 assert.deepEqual(h.sheets.map(s=>s.name),['가나다라마','거래처검토','품목검토','조건검토','abcde','거래처검토 1','😀가나다라']);
 assert.equal(h.sheets[1].cells[0][0],'가나다라마바.pdf');
 h.sheets[1].name='사용자 지정';await h.review.ensure('c','b','가나다라마바.pdf',[row(),item]);
 assert.equal(h.sheets[1].name,'사용자 지정');
});
