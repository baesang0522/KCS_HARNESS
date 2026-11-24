const test=require('node:test'),assert=require('node:assert/strict');
const {createDOM}=require('../helpers/taskpane_dom.cjs');
function setup(){const h=createDOM();h.window.workspaceTable={batchSize:1000};h.load('operations/operations_sheet.js');h.load('operations/operations_ui.js');
 const ui=h.window.createOperationsUI(h.messages);ui.show([{column_id:'source',header:'공급자명'},{column_id:'result',header:'확정명'}],['source']);
 return {...h,ui,operation:{kind:'preprocess',column_ids:['source'],rules:[{operation:'collapse_whitespace'}]}};}
function preview(h){return {operation:h.ui.operation(),snapshot:{columns:[{header:'공급자명'}],rows:[{excel_row:2,values:['ABC  LTD'],destination:'old'}]},values:[['ABC LTD']],changed:1,names:['정제']};}
test('chat settings default to a named new column and preserve ordered independent rules',()=>{
 const h=setup();h.operation.rules=[{operation:'remove_hangul'},{operation:'remove_brackets'}];h.ui.configure(h.operation);
 assert.equal(h.ui.output().mode,'new');assert.equal(h.ui.output().name,'공급자명 정제');
 assert.deepEqual(Array.from(h.ui.operation().rules,r=>r.operation),['remove_hangul','remove_brackets']);assert.equal(h.document.getElementById('operations'),null);
});
test('destination change revokes old approval and applies only the new proposal once',async()=>{
 const h=setup();let count=0;h.ui.bind({apply:()=>count++,edit:()=>{}});h.ui.configure(h.operation);h.ui.preview(preview(h));
 assert.match(h.chatText(),/1행 중 1행/);assert.match(h.chatText(),/ABC  LTD/);assert.match(h.chatText(),/공급자명 정제/);
 const old=h.action('적용');h.ui.configure({...h.operation,output:{mode:'existing',column_id:'result'}});h.ui.preview(preview(h));
 assert.equal(old.disabled,true);await old.emit('click');assert.equal(count,0);
 assert.match(h.chatText(),/기존 열 ‘확정명’/);await h.messages.command('적용');await h.messages.command('적용');assert.equal(count,1);
});
test('missing output and inconsistent conditional destination fail before confirmation',()=>{
 const h=setup();assert.throws(()=>h.ui.configure({...h.operation,output:{mode:'existing',column_id:'deleted'}}),/삭제/);
 assert.throws(()=>h.ui.configure({...h.operation,condition:{},destination_column_id:'result',output:{mode:'new'}}),/일치하지/);
 assert.equal(h.action('적용'),undefined);
});
test('previous extraction recommendations cannot modify a later request',async()=>{
 const h=setup();let previews=0;h.ui.bind({preview:()=>previews++});h.ui.configure({...h.operation,kind:'extract'});
 h.ui.extractionSuggestions({sample_count:1,suggestions:[{label:'문자 숫자',mode:'alphanumeric',matched_rows:1,multiple_rows:0}]});
 const old=h.action('문자 숫자 사용');h.ui.configure(h.operation);await old.emit('click');assert.equal(previews,0);assert.match(h.chatText(),/작업이 바뀌/);
});
test('full results are paginated without truncation and cell content remains text',async()=>{
 const h=setup(),rows=Array.from({length:23},(_,i)=>[i,'<img src=x onerror=alert(1)>']);h.messages.table(h.messages.say('결과'),['행','값'],rows);
 assert.match(h.chatText(),/1–10 \/ 23/);await h.action('다음').emit('click');await h.action('다음').emit('click');
 assert.match(h.chatText(),/21–23 \/ 23/);assert.equal(h.document.getElementById('conversation').querySelectorAll('img').length,0);
});

test('a conflicting new column name is resolved in the preview before approval',()=>{
 const h=setup();h.ui.configure({...h.operation,output:{mode:'new',name:'공급자명'}});h.ui.bind({apply(){},edit(){}});h.ui.preview(preview(h));
 assert.match(h.chatText(),/새 열 ‘공급자명 2’/);
});

test('retired confirmations never run callbacks and the active callback still runs once',async()=>{
 const h=setup();let first=0,second=0;
 const old=h.messages.confirm('old',{apply:()=>first++,cancel:()=>first++});
 const oldButton=h.action('적용');
 h.messages.confirm('new',{apply:()=>second++,cancel:()=>second++});
 await oldButton.emit('click');await old.run('cancel');
 await h.messages.command('적용');await h.messages.command('적용');
 assert.equal(first,0);assert.equal(second,1);
 const reset=h.messages.confirm('reset',{apply:()=>first++,cancel:()=>first++});
 h.messages.reset();await reset.run('apply');assert.equal(first,0);
});
