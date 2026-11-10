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
