const test = require('node:test'), assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');
const {createInvestigationHost} = require('../helpers/investigation_host.cjs');
const supplier = {target:{kind:'supplier',group:'1',category:'제조사',company_name:'회사(ACME)'},source_pages:[1]};
const item = {target:{kind:'item',group:'1',hs_codes:['7208511000'],specification:'SA516-70',requirements:'134mm 이상'},source_pages:[1]};
async function setup() {
    const h=createDOM(), excel=createInvestigationHost();h.excel=excel;h.node=id=>h.document.getElementById(id);
    let serial=0;const docs=new Map();
    h.state={revision:0,conditions:[],reviews:{},document_notes:{},workspace:null};
    h.calls=[];
    h.api={newRequestId:()=>String(++serial).padStart(12,'0'),requestJson:async(url,opts={})=>{
        h.calls.push({url,opts});
        if(url==='/conversations')return {conversation_id:'conversation'};
        if(url.endsWith('/documents'))return {documents:[...docs.values()]};
        if(url.includes('/documents/')&&opts.method==='POST'){
            const did=url.split('/documents/')[1].split('?')[0],doc={document_id:did,filename:opts.body.name,page_count:1,unreadable_pages:[]};
            docs.set(did,doc);return doc;
        }
        if(url.includes('/extractions/')){
            const {document_id:did}=JSON.parse(opts.body), row=docs.get(did).filename.includes('품목')?item:supplier;
            h.state.reviews[did]=[structuredClone(row)];h.state.document_notes[did]=[];
            h.state.conditions.push({source_document_id:did,status:'candidate'});h.state.revision++;
        }
        if(url.includes('/reviews/')){
            const did=url.split('/reviews/')[1],payload=JSON.parse(opts.body);
            assert.deepEqual(payload.expected_rows,h.state.reviews[did]);h.state.reviews[did]=payload.rows;
            h.state.conditions.filter(c=>c.source_document_id===did).forEach(c=>c.status='confirmed');h.state.revision++;
        }
        return structuredClone(h.state);
    }};
    excel.window.apiClient=h.api;excel.load('documents/review_sheet.js');h.window.investigationSheet=excel.window.investigationSheet;
    ['chat/chat.js','documents/documents.js','documents/investigation.js'].forEach(h.load);
    h.chat=h.window.createChatController({api:h.api,getWorkspace:()=>null,closeTaskCards(){},resetTasks(){},handleUIAction(){},
        onConversationChanged:id=>Promise.all([h.documents.load(id),h.investigation.load(id)]),
        onBusy:()=>h.documents?.updateControls()});
    const shared={api:h.api,isBusy:h.chat.isBusy,setBusy:h.chat.setBusy,beginRequest:h.chat.beginRequest,endRequest:h.chat.endRequest,checkRequest:h.chat.checkRequest,reportStop:h.chat.reportStop};
    h.investigation=h.window.createInvestigationController({...shared,getWorkspace:()=>null,onChanged:()=>h.documents?.render()});
    h.documents=h.window.createDocumentsController({...shared,beforeUpload:h.investigation.prepare,readConditions:h.investigation.extract,
        reviewInfo:h.investigation.info,applyReview:h.investigation.apply,preprocessReview:async()=>{}});
    await h.chat.initialize();
    h.upload=async(...names)=>{h.node('document-file').files=names.map(name=>({name}));await h.node('document-file').emit('change');};
    return h;
}
test('supplier then item from file picker keep distinct editable sheets and per-document confirmation',async()=>{
    const h=await setup();await h.upload('거래처.pdf');
    const supplierSheet=h.excel.sheets[0],did1=Object.keys(h.state.reviews)[0];supplierSheet.cells[4][2]='사용자가 수정한 회사';
    await h.upload('품목.pdf');
    assert.equal(h.excel.sheets.length,2);assert.equal(h.chat.isBusy(),false);assert.equal(h.node('document-add').disabled,false);
    assert.equal(h.node('documents-list').children.length,2);assert.equal(supplierSheet.cells[4][2],'사용자가 수정한 회사');
    assert.deepEqual(h.node('documents-list').querySelectorAll('button').map(b=>b.textContent),['전처리','수정 내용 반영','전처리','수정 내용 반영']);
    const did2=Object.keys(h.state.reviews)[1];assert.equal(h.excel.active,h.excel.sheets[1]);
    assert.notEqual(h.excel.sheets[0].id,h.excel.sheets[1].id);
    await h.investigation.apply(did1);assert.equal(h.state.reviews[did1][0].target.company_name,'사용자가 수정한 회사');
    assert.deepEqual(h.state.reviews[did2],[item]);
    h.excel.sheets[1].cells[4][3]='150mm 이상';await h.investigation.apply(did2);
    assert.equal(h.state.reviews[did2][0].target.requirements,'150mm 이상');assert.equal(h.state.reviews[did1][0].target.company_name,'사용자가 수정한 회사');
});
test('one file selection processes both PDFs into separate sheets; reattaching does not overwrite either',async()=>{
    const h=await setup();await h.upload('거래처.pdf','품목.pdf');assert.equal(h.excel.sheets.length,2);
    const before=h.excel.sheets.map(s=>structuredClone(s.cells));await h.upload('거래처.pdf');
    assert.equal(h.excel.sheets.length,3);assert.deepEqual(h.excel.sheets.slice(0,2).map(s=>s.cells),before);
    assert.equal(h.node('document-file').value,'');assert.equal(h.chat.isBusy(),false);
});

test('Excel failure offers only retry until its sheet exists, including after reload',async()=>{
    const h=await setup(),sheet=h.window.investigationSheet,ensure=sheet.ensure;
    sheet.ensure=async()=>{throw Error('Excel 연결 실패');};await h.upload('거래처.pdf');
    const labels=()=>h.node('documents-list').querySelectorAll('button').map(b=>b.textContent);
    assert.deepEqual(labels(),['추출 다시 시도']);assert.match(h.node('documents-status').textContent,/Excel 연결 실패/);
    await h.investigation.load('conversation');assert.deepEqual(labels(),['추출 다시 시도']);
    sheet.ensure=ensure;await h.node('documents-list').querySelector('button').emit('click');
    assert.deepEqual(labels(),['전처리','수정 내용 반영']);assert.equal(h.excel.sheets.length,1);
    await h.investigation.load('conversation');assert.deepEqual(labels(),['전처리','수정 내용 반영']);
    assert.equal(h.calls.filter(c=>c.url.includes('/extractions/')).length,1);
});
