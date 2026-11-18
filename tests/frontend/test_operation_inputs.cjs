const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

test('operation UI collects unfinished settings for server validation without duplicating error text', () => {
    const h = createDOM();
    h.window.createMappingEditor = () => ({get: () => []});
    h.load('operations/operations_ui.js');
    const ui = h.window.createOperationsUI();
    const node = id => h.document.getElementById('op-' + id);
    node('kind').value = 'replace'; node('find').value = '';
    assert.equal(ui.operation().find, '');
    node('kind').value = 'split'; node('delimiter-mode').value = 'custom'; node('delimiter').value = '';
    assert.equal(ui.operation().delimiter, '');
    node('kind').value = 'map'; assert.equal(ui.operation().mappings.length, 0);
    node('kind').value = 'extract'; assert.equal(ui.operation().extraction_mode, null);
    node('kind').value = 'group'; node('group-mode').value = 'manual'; node('source-row').value = '';
    assert.equal(ui.operation().source_row, 0);
});

test('common operation card exposes Hangul and bracket removal as independent rules',()=>{
    const h=createDOM();h.window.createMappingEditor=()=>({get:()=>[]});h.load('operations/operations_ui.js');
    const ui=h.window.createOperationsUI(),kind=h.document.getElementById('op-kind');kind.value='preprocess';
    const inputs=h.document.getElementById('op-rules').querySelectorAll('input');
    const hangul=inputs.find(i=>i.value==='remove_hangul'),brackets=inputs.find(i=>i.value==='remove_brackets');
    hangul.checked=true;assert.deepEqual(Array.from(ui.operation().rules,r=>r.operation),['remove_hangul']);
    hangul.checked=false;brackets.checked=true;assert.deepEqual(Array.from(ui.operation().rules,r=>r.operation),['remove_brackets']);
    hangul.checked=true;assert.deepEqual(Array.from(ui.operation().rules,r=>r.operation),['remove_hangul','remove_brackets']);
});
