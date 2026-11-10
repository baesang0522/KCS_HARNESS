const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const requests = [], progress = [], window = {operationsSheet: {read: async () => ({rows:
        Array.from({length: 10001}, (_, i) => ({values: ['MODEL: AB' + i]}))})}};
    const api = {requestJson: async (url, options) => {
        const {values} = JSON.parse(options.body); requests.push({url, values});
        return {sample_count: values.length, suggestions: [{mode: 'label', matched_rows: values.length,
            multiple_rows: 1, examples: values.slice(0, 2)}]};
    }};
    window.errorMessages = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/services/error_messages.json'), 'utf8'));
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/static/excel/operations/extraction_suggestions.js'), 'utf8'), {window});
    const workspace = {task_type: 'model_normalization', columns: [{column_id: 'model', role: 'model_spec'}]};
    return {window, workspace, api, requests, progress};
}
test('extraction recommendations inspect every row in bounded requests and merge counts', async () => {
    const h = setup();
    const result = await h.window.readExtractionSuggestions(h.workspace, {}, ['model'], h.api, (...args) => h.progress.push(args));
    assert.equal(h.requests.length, 2); assert.equal(h.requests[0].values.length, 10000); assert.equal(h.requests[1].values.length, 1);
    assert.equal(result.sample_count, 10001); assert.equal(result.suggestions[0].matched_rows, 10001);
    assert.equal(result.suggestions[0].multiple_rows, 2); assert.equal(result.suggestions[0].examples.length, 2);
    assert.equal(h.progress.at(-1)[1], 10001);
});
test('wrong role is rejected before reading; API errors propagate instead of showing partial recommendations', async () => {
    const h = setup(); let reads = 0;
    const read = h.window.operationsSheet.read;
    h.window.operationsSheet.read = async (...args) => { reads++; return read(...args); };
    await assert.rejects(() => h.window.readExtractionSuggestions(h.workspace, {}, ['trade'], h.api, () => {}), /모델규격 추출/);
    assert.equal(reads, 0);
    h.api.requestJson = async () => { throw new Error('server unavailable'); };
    await assert.rejects(() => h.window.readExtractionSuggestions(h.workspace, {}, ['model'], h.api, () => {}), /server unavailable/);
});
