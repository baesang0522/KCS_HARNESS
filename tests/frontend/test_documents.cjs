const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

async function setup() {
    const h = createDOM();
    h.node = id => h.document.getElementById(id);
    h.ready=false; h.reflected=0; h.reflect=async()=>{h.reflected++;};
    h.extracted=[]; h.context = null; h.requests = []; h.storage = new Map(); h.serial = 0;
    h.reply = async (url, options) => {
        if (url === '/conversations') return {conversation_id: 'conv-' + ++h.serial};
        if (url.endsWith('/cancel')) { h.cancelled = true; return {status: 'cancelled'}; }
        if (url.endsWith('/documents')) return {documents: Array.from(h.storage.values())};
        const id = url.split('/documents/')[1]?.split(/[/?]/)[0];
        if (options.method === 'POST') {
            const result = {document_id: id, filename: options.body.name, page_count: 2, unreadable_pages: [2], link: null};
            h.storage.set(id, result); return result;
        }
        if (options.method === 'PUT') {
            const result = {...h.storage.get(id), link: JSON.parse(options.body)};
            h.storage.set(id, result); return result;
        }
        if (options.method === 'DELETE') { h.storage.delete(id); return {status: 'deleted'}; }
        if (url.includes('/pages/')) return {page_number: 1, text: '분석대상 ABC', readable: true};
        return {messages: []};
    };
    h.api = {newRequestId: () => 'doc-' + ++h.serial, requestJson: async (url, options = {}) => {
        h.requests.push({url, options}); return h.reply(url, options);
    }};
    h.load('chat/chat.js'); h.load('documents/documents.js');
    h.chat = h.window.createChatController({api: h.api, getWorkspace: () => null,
        closeTaskCards() {}, resetTasks() {}, handleUIAction() {},
        onConversationChanged: id => h.documents.load(id),
        onBusy: () => { if (h.documents) h.documents.updateControls(); }});
    h.documents = h.window.createDocumentsController({applyReview:()=>h.reflect(),reviewInfo:()=>({ready:h.ready,count:1,warnings:[]}),api: h.api, getWorkspace: () => h.context,
        beforeUpload:async()=>{h.prepared=true;},readConditions:async(id,name)=>{h.extracted.push({id,name});return true;},
        isBusy: h.chat.isBusy, setBusy: h.chat.setBusy, beginRequest: h.chat.beginRequest,
        endRequest: h.chat.endRequest, checkRequest: h.chat.checkRequest, reportStop: h.chat.reportStop});
    await h.chat.initialize();
    h.upload = async (name = '기준.pdf') => { h.node('document-file').files = [{name}]; await h.node('document-file').emit('change'); };
    h.button = text => h.node('documents-list').querySelectorAll('button').find(button => button.textContent === text);
    return h;
}

test('upload automatically extracts without redundant source, sheet-open or removal controls',async()=>{
    const h=await setup();await h.upload();
    assert.equal(h.prepared,true);assert.equal(h.extracted.length,1);
    assert.equal(h.node('documents-list').querySelector('select'),null);
    assert.match(h.node('documents-list').textContent,/텍스트 없음: 2쪽/);
    assert.equal(h.button('원문 보기'),undefined);assert.equal(h.button('검토 시트 열기'),undefined);
    assert.equal(h.node('document-preview'),null);
    await h.node('documents-toggle').emit('click');assert.equal(h.node('documents-panel').hidden,true);
    assert.match(h.node('documents-toggle').textContent,/추출내용 보기/);
    await h.node('documents-toggle').emit('click');assert.equal(h.node('documents-panel').hidden,false);
    assert.equal(h.button('제거'),undefined);assert.equal(h.button('삭제'),undefined);
    assert.equal(h.node('documents-list').children.length,1);
    assert.equal(h.requests.some(r=>r.options.method==='DELETE'),false);assert.equal(h.requests.some(r=>r.url==='/chat'),false);
});

test('file drop uses the same sequential upload and extraction flow; invalid types do not upload',async()=>{
    const h=await setup();let prevented=false;
    await h.node('composer').emit('drop',{preventDefault(){prevented=true;},dataTransfer:{files:[{name:'한글.pdf'},{name:'영문.PDF'}]}});
    assert.equal(prevented,true);assert.deepEqual(h.extracted.map(e=>e.name),['한글.pdf','영문.PDF']);
    await h.upload('photo.png');assert.equal(h.extracted.length,2);assert.match(h.node('documents-status').textContent,/PDF 파일만/);
    await h.upload('<img src=x>.pdf');assert.equal(h.node('documents-list').querySelectorAll('img').length,0);
});

test('existing stop button cancels PDF request and ignores a late upload response', async () => {
    const h = await setup(); const original = h.reply;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    h.reply = async (url, options) => {
        if (options.method === 'POST' && url.includes('/documents/')) {
            entered(); return new Promise(resolve => { release = () => resolve({document_id: 'late', filename: 'late.pdf', page_count: 1, unreadable_pages: [], link: null}); });
        }
        return original(url, options);
    };
    const upload = h.upload(); await started;
    assert.equal(h.node('composer').querySelector('[type="submit"]').getAttribute('aria-label'), '요청 중지');
    await h.node('composer').emit('submit');
    release(); await upload;
    assert.equal(h.cancelled, true);
    assert.equal(h.node('documents-list').children.length, 0);
    assert.match(h.node('documents-status').textContent, /중지/);
    assert.equal(h.chat.isBusy(), false);
});

test('changing conversations ignores a late attachment list response', async () => {
    const h = await setup(); await h.upload();
    const original = h.reply; let release;
    h.reply = (url, options) => url.endsWith('/documents') ? new Promise(resolve => { release = resolve; }) : original(url, options);
    const refresh = h.documents.refresh();
    h.reply = original; h.storage.clear();
    await h.chat.newConversation();
    release({documents:[{document_id:'old',filename:'이전 대화 파일.pdf',page_count:1,unreadable_pages:[]}]}); await refresh;
    assert.equal(h.node('documents-list').children.length, 0);
});

test('upload errors stay visible and do not create a ready attachment', async () => {
    const h = await setup(); const original = h.reply;
    h.reply = async (url, options) => {
        if (options.method === 'POST' && url.includes('/documents/')) throw new Error('암호가 설정된 PDF입니다.');
        return original(url, options);
    };
    await h.upload();
    assert.match(h.node('documents-status').textContent, /암호/);
    assert.equal(h.node('documents-list').children.length, 0);
    assert.equal(h.node('document-add').disabled, false);
});


test('document list exposes IDs and statuses for chat retry without per-file action buttons',async()=>{
 const page=createDOM();page.load('documents/documents.js');const doc={document_id:'reference',filename:'기준.pdf',page_count:1,unreadable_pages:[],link:null};
 const controller=page.window.createDocumentsController({api:{requestJson:async()=>({documents:[doc]})},getWorkspace:()=>null,isBusy:()=>false,setBusy(){}});
 await controller.load('conversation');assert.equal(controller.items()[0].document_id,'reference');
 assert.equal(page.document.getElementById('documents-list').querySelectorAll('button').length,0);
 assert.match(page.document.getElementById('documents-list').textContent,/기준.pdf/);
});

test('stopping the first upload stops the remaining dropped-file queue',async()=>{
    const h=await setup(),original=h.reply;let release,entered;
    const started=new Promise(resolve=>entered=resolve);
    h.reply=async(url,opts)=>{if(opts.method==='POST'&&url.includes('/documents/')){entered();return new Promise(resolve=>release=()=>resolve({document_id:'late',filename:'a.pdf',page_count:1,unreadable_pages:[]}));}return original(url,opts);};
    const pending=h.node('composer').emit('drop',{dataTransfer:{files:[{name:'a.pdf'},{name:'b.pdf'}]}});
    await started;await h.node('composer').emit('submit');release();await pending;
    assert.equal(h.requests.filter(r=>r.options.method==='POST'&&r.url.includes('/documents/')).length,1);
    assert.equal(h.extracted.length,0);
});

test('drawer sits outside chat immediately above footer and closes without changing scroll or draft',async()=>{
 const h=await setup(),main=h.document.querySelector('main'),panel=h.node('documents-panel');
 assert.equal(main.contains(panel),false);assert.equal(panel.parentNode.nextSibling.tagName,'footer');
 main.scrollTop=460;h.node('message').value='작성 중인 질문';
 await h.node('documents-toggle').emit('click');assert.equal(panel.hidden,false);
 assert.equal(h.node('documents-toggle').getAttribute('aria-expanded'),'true');assert.equal(main.scrollTop,460);
 h.node('documents-content').scrollTop=100;await panel.emit('keydown',{key:'Escape'});
 assert.equal(panel.hidden,true);assert.equal(h.node('documents-toggle').focused,true);assert.equal(main.scrollTop,460);
 await h.node('documents-toggle').emit('click');assert.equal(h.node('documents-content').scrollTop,100);
 await h.node('documents-toggle').emit('keydown',{key:'Escape'});assert.equal(panel.hidden,true);
 await h.node('documents-toggle').emit('click');
 await h.node('documents-close').emit('click');assert.equal(main.scrollTop,460);assert.equal(h.node('message').value,'작성 중인 질문');
});
test('reflection button allows review recheck after upload and blocks duplicate or busy requests',async()=>{
 const h=await setup(),button=h.node('documents-apply');assert.equal(button.disabled,true);await button.emit('click');assert.equal(h.reflected,0);
 await h.upload();assert.equal(button.disabled,false);assert.equal(h.ready,false);
 h.chat.setBusy(true);await button.emit('click');assert.equal(h.reflected,0);h.chat.setBusy(false);
 let finish;h.reflect=()=>{h.reflected++;return new Promise(resolve=>finish=resolve);};
 const pending=button.emit('click');await button.emit('click');assert.equal(h.reflected,1);assert.equal(button.disabled,true);
 assert.equal(h.node('documents-panel').hidden,false);finish();await pending;assert.equal(button.disabled,false);assert.equal(h.node('documents-panel').hidden,true);
 assert.equal(h.requests.some(r=>r.url==='/chat'),false);
});
test('failed reflection request keeps the drawer open with its error and permits retry',async()=>{
 const h=await setup();await h.upload();h.ready=true;h.documents.render();h.reflect=async()=>{throw Error('검토 시트를 다시 확인하세요.');};
 await h.node('documents-apply').emit('click');assert.equal(h.node('documents-panel').hidden,false);
 assert.match(h.node('documents-status').textContent,/검토 시트를 다시 확인/);assert.equal(h.node('documents-apply').disabled,false);
});


test('reflection errors keep the drawer open and reveal the actual error above a scrolled list',async()=>{
 const h=await setup();await h.upload();h.ready=true;h.documents.render();
 const content=h.node('documents-content');content.scrollTop=900;
 h.reflect=async()=>{assert.equal(h.node('documents-panel').hidden,false);throw Error('검토 열 연결 오류');};
 await h.node('documents-apply').emit('click');
 assert.equal(h.node('documents-panel').hidden,false);assert.equal(content.scrollTop,0);
 assert.equal(h.node('documents-status').textContent,'검토 열 연결 오류');assert.equal(h.node('documents-apply').disabled,false);
 h.reflect=async()=>{};await h.node('documents-apply').emit('click');assert.equal(h.node('documents-panel').hidden,true);
});
