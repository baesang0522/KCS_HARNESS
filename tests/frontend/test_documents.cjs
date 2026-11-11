const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

async function setup() {
    const h = createDOM();
    h.node = id => h.document.getElementById(id);
    h.context = null; h.requests = []; h.storage = new Map(); h.serial = 0;
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
    h.documents = h.window.createDocumentsController({api: h.api, getWorkspace: () => h.context,
        isBusy: h.chat.isBusy, setBusy: h.chat.setBusy, beginRequest: h.chat.beginRequest,
        endRequest: h.chat.endRequest, checkRequest: h.chat.checkRequest, reportStop: h.chat.reportStop});
    await h.chat.initialize();
    h.upload = async (name = '기준.pdf') => { h.node('document-file').files = [{name}]; await h.node('document-file').emit('change'); };
    h.button = text => h.node('documents-list').querySelectorAll('button').find(button => button.textContent === text);
    return h;
}

test('PDF uploads without a workspace, previews by page, binds pending task then only matching workspace', async () => {
    const h = await setup(); await h.upload();
    assert.equal(h.node('documents-panel').hidden, false);
    assert.match(h.node('documents-list').textContent, /텍스트 없음: 2쪽/);
    assert.equal(h.node('documents-list').querySelector('select').value, '');
    await h.button('추출 내용 보기').emit('click');
    assert.match(h.node('document-page-body').textContent, /ABC/);
    h.node('documents-list').querySelector('select').value = 'counterparty_cleanup';
    await h.button('연결').emit('click');
    assert.match(h.node('documents-list').textContent, /작업표 준비 대기/);
    await h.documents.attachPending({task_type: 'model_normalization', workspace_id: 'other'});
    assert.equal(h.requests.filter(r => r.options.method === 'PUT').length, 1);
    const workspace = {task_type: 'counterparty_cleanup', workspace_id: 'work', worksheet_id: 's', table_id: 't', sheet_name: '해외'};
    await h.documents.attachPending(workspace);
    assert.match(h.node('documents-list').textContent, /연결: 해외/);
    await h.documents.attachPending({...workspace, workspace_id: 'different'});
    assert.equal(h.requests.filter(r => r.options.method === 'PUT').length, 2);
    await h.button('제거').emit('click');
    assert.equal(h.node('documents-toggle').textContent, '참고자료 (0)');
    assert.equal(h.node('document-preview').hidden, true);
    assert.equal(h.requests.some(r => r.url === '/chat'), false);
});

test('current workspace is suggested and connected; PDF names are text, not HTML', async () => {
    const h = await setup();
    h.context = {task_type: 'model_normalization', workspace_id: 'work', sheet_name: '모델'};
    await h.upload('<img src=x onerror=alert(1)>.pdf');
    assert.equal(h.node('documents-list').querySelector('select').value, 'model_normalization');
    assert.equal(h.node('documents-list').querySelectorAll('img').length, 0);
    await h.button('연결').emit('click');
    const call = h.requests.find(r => r.options.method === 'PUT');
    assert.equal(JSON.parse(call.options.body).workspace.workspace_id, 'work');
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
    assert.equal(h.node('documents-toggle').textContent, '참고자료 (0)');
    assert.match(h.node('documents-status').textContent, /중지/);
    assert.equal(h.chat.isBusy(), false);
});

test('changing conversations clears attachments and a late preview cannot reappear', async () => {
    const h = await setup(); await h.upload();
    const original = h.reply; let release;
    h.reply = (url, options) => url.includes('/pages/') ? new Promise(resolve => { release = resolve; }) : original(url, options);
    const preview = h.button('추출 내용 보기').emit('click');
    h.storage.clear();
    await h.node('new-chat').emit('click');
    release({readable: true, text: '이전 대화 비밀 내용'}); await preview;
    assert.equal(h.node('document-preview').hidden, true);
    assert.equal(h.node('documents-toggle').textContent, '참고자료 (0)');
    assert.equal(h.node('document-page-body').textContent.includes('비밀'), false);
});

test('upload errors stay visible and do not create a ready attachment', async () => {
    const h = await setup(); const original = h.reply;
    h.reply = async (url, options) => {
        if (options.method === 'POST' && url.includes('/documents/')) throw new Error('암호가 설정된 PDF입니다.');
        return original(url, options);
    };
    await h.upload();
    assert.match(h.node('documents-status').textContent, /암호/);
    assert.equal(h.node('documents-toggle').textContent, '참고자료 (0)');
    assert.equal(h.node('document-add').disabled, false);
});
