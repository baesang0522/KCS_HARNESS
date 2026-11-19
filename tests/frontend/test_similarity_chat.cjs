const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
async function setup(resultSheet=false){const h=createDOM();let busy=false;h.writes=0;h.current={stamp:'same',rows:[{excel_row:2,values:['ABC']},{excel_row:3,values:['AB C']}]};
 h.window.operationsSheet={read:async()=>structuredClone(h.current)};h.window.similaritySheet={write:async()=>{h.writes++;return '비교 결과';}};
 h.load('similarity/similarity.js');h.controller=h.window.createSimilarityController({messages:h.messages,isBusy:()=>busy,setBusy:v=>busy=v,status(){},complete:text=>h.messages.say(text),
 getInput:async()=>({workspace:{},target:{}}),api:{newRequestId:()=> 'id',requestJson:async()=>({rows:[{base:'ABC',candidate:'AB C',score:80,base_count:1,candidate_count:1,group:'',base_row:2,candidate_row:3}]})}});
 await h.controller.run({column_id:'source',method:'sequence',result_sheet:resultSheet});return h;}
test('similarity reports computed pairs in chat and creates no sheet by default',async()=>{const h=await setup();assert.equal(h.writes,0);assert.match(h.chatText(),/2행에서 1쌍/);assert.match(h.chatText(),/공통 문자열/);assert.match(h.chatText(),/80/);assert.equal(h.action('적용'),undefined);});
test('explicit similarity result sheet requires approval and rejects later input edits',async()=>{const h=await setup(true);assert.equal(h.writes,0);await h.messages.command('적용');assert.equal(h.writes,1);
 const stale=await setup(true);stale.current.rows[0].values[0]='edited';await stale.messages.command('적용');assert.equal(stale.writes,0);assert.match(stale.chatText(),/바뀌었/);});
