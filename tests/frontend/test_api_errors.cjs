const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function client(fetch) {
    const window = {location: {pathname: '/prefix/static/excel/taskpane-current.html'}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/static/excel/common/api_client.js'), 'utf8'), {window, fetch});
    return window.apiClient;
}
test('server error text and HTTP status are preserved without client prefixes', async () => {
    const message = '찾을 문자열을 입력하세요.';
    const api = client(async url => {
        assert.equal(url, '/prefix/operation-jobs');
        return {ok: false, status: 422, json: async () => ({detail: message})};
    });
    await assert.rejects(() => api.requestJson('/operation-jobs'), error => error.message === message && error.status === 422);
});
test('proxy HTML and broken successful responses use transport fallback, not HTML or parser errors', async () => {
    const brokenJSON = async () => { throw new SyntaxError('<html>bad gateway secret</html>'); };
    const proxy = client(async () => ({ok: false, status: 502, json: brokenJSON}));
    await assert.rejects(() => proxy.requestJson('/chat'), error => error.status === 502 && error.message.includes('HTTP 502') && !error.message.includes('secret'));
    const invalid = client(async () => ({ok: true, status: 200, json: brokenJSON}));
    await assert.rejects(() => invalid.requestJson('/chat'), /서버 응답을 읽지 못했습니다/);
});
test('network failure has one connection message; cancellation stays an AbortError', async () => {
    const api = client(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(() => api.requestJson('/chat'), /서버에 연결하지 못했습니다/);
    const aborted = new DOMException('cancelled', 'AbortError');
    const cancelled = client(async () => { throw aborted; });
    await assert.rejects(() => cancelled.requestJson('/chat'), error => error === aborted);
});
