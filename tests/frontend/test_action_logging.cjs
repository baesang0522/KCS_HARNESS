const test = require('node:test');
const assert = require('node:assert/strict');
const {createDOM} = require('../helpers/taskpane_dom.cjs');

test('taskpane forwards the chat origin to operation configuration and formula scope', async () => {
    const h = createDOM(), seen = [];
    let chatOptions;
    h.window.apiClient = {};
    h.window.createChatController = options => {
        chatOptions = options;
        return {initialize(){},isBusy:()=>false,setBusy(){}};
    };
    h.window.createTaskMessages = () => ({reset(){}});
    h.window.createWriteRecovery = () => ({});
    h.window.createWorkspaceController = () => ({
        cancelPending(){},configure:async (operation, origin)=>seen.push({operation,origin}),previewOperation:async()=>{}
    });
    h.window.createFormulaUI = () => ({});
    h.window.createFormulaController = () => ({dismiss(){},openAndSelect:(instruction,scope)=>seen.push({instruction,scope})});
    h.window.createInvestigationController = () => ({reviewContext: async () => []});
    h.window.createReviewPreprocess = () => ({});
    h.window.createDocumentsController = () => ({});
    h.window.createAgentController = () => ({});
    h.load('taskpane.js');
    const operation = {kind:'preprocess',column_ids:['in'],rules:[{operation:'trim'}]};
    await chatOptions.handleUIAction({type:'configure_operation',operation},'공백 제거','chat-1');
    await chatOptions.handleUIAction({type:'confirm_selection',task_type:'formula',workspace_id:'work',column_ids:['in']},'두 배','chat-2');
    assert.equal(seen[0].origin,'chat-1');assert.deepEqual(seen[0].operation,operation);
    assert.equal(seen[1].scope.origin_request_id,'chat-2');assert.equal(seen[1].instruction,'두 배');
});
