// In-memory Excel contract double for table/row identity, sparse writes and source snapshots.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function createInvestigationHost() {
    let next = 0; const sheets = [], settings = new Map();
    const host = {writes: [], syncs: 0, beforeSync: null};
    function range(sheet, r, c, n, m) {
        const read = () => Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>sheet.cells[r+i]?.[c+j] ?? ''));
        const formats = () => Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>sheet.formats[r+i]?.[c+j] ?? 'General'));
        const loaded = {};
        const x = {rowIndex:r,columnIndex:c,rowCount:n,columnCount:m,worksheet:sheet,
            address:`${sheet.name}!R${r+1}C${c+1}:R${r+n}C${c+m}`,format:{},
            load(properties){if(/text|values|formulas/.test(properties)&&n*m>20000)throw new Error('unbounded read'); for(const property of properties.split(',')) {if(property==='text')loaded.text=read().map(row=>row.map(String)); else if(property==='numberFormat')loaded.numberFormat=formats(); else if(['values','formulas'].includes(property))loaded[property]=read();} return x;},
            select(){host.selection=x;},
            copyFrom(input,type){if(type==='Values') x.values=input.values; else if(type==='Formats')x.numberFormat=input.numberFormat; else throw new Error(type);},
            getUsedRangeOrNullObject(){return {isNullObject:!read().flat().some(v=>v!==''),load(){}};}};
        Object.defineProperties(x,{
            values:{get:()=>loaded.values||read(),set:matrix=>{
                if(sheet.protected)throw new Error('protected sheet');
                if(matrix.length!==n||matrix.some(row=>row.length!==m))throw new Error('shape mismatch');
                host.writes.push({sheet:sheet.id,r,c,n,m});
                matrix.forEach((row,i)=>row.forEach((v,j)=>{sheet.cells[r+i] ||= [];sheet.cells[r+i][c+j]=typeof v==='string'&&v.startsWith("'")?v.slice(1):v;}));
            }},
            text:{get:()=>loaded.text||read().map(row=>row.map(String))},
            formulas:{get:()=>loaded.formulas||read()},
            numberFormat:{get:()=>loaded.numberFormat||formats(),set:matrix=>matrix.forEach((row,i)=>row.forEach((v,j)=>{sheet.formats[r+i] ||= [];sheet.formats[r+i][c+j]=v;}))},
        });return x;
    }
    function addSheet(name, cells=[]) {
        const sheet={id:'sheet-'+ ++next,name,cells:structuredClone(cells),formats:[],protected:false,visibility:'Visible',load(){},activate(){host.active=sheet;},
            getRangeByIndexes:(...args)=>range(sheet,...args),getRange:()=>({columnHidden:false}),
            getUsedRangeOrNullObject:()=>Object.assign(range(sheet,0,0,sheet.cells.length,Math.max(0,...sheet.cells.map(r=>r.length))),{isNullObject:!sheet.cells.length}),
            protection:{protect(){sheet.protected=true;}},isNullObject:false};
        sheet.tables={items:[],getItem(id){const t=this.items.find(t=>t.id===id);if(!t)throw new Error('table not found');return t;},
            add(area){
                const table={id:'table-'+ ++next,start:area.rowIndex,left:area.columnIndex,count:area.rowCount-1,load(){},
                    getDataBodyRange:()=>range(sheet,table.start+1,table.left,table.count,table.columns.items.length),
                    getRange:()=>range(sheet,table.start,table.left,table.count+1,table.columns.items.length)};
                const items=[];
                function col(name,id='column-'+ ++next){return {id,load(){},get index(){return items.indexOf(this);},
                    get name(){return sheet.cells[table.start][table.left+items.indexOf(this)];},
                    set name(value){sheet.cells[table.start][table.left+items.indexOf(this)]=value;}};}
                for(let i=0;i<area.columnCount;i++) items.push(col(sheet.cells[table.start][table.left+i]));
                table.columns={items,load(){},add(index,values,name){
                    if(index===null)index=items.length;
                    for(let r=table.start;r<=table.start+table.count;r++) {sheet.cells[r] ||= []; sheet.cells[r].splice(table.left+index,0,r===table.start?name:'');}
                    const result=col(name);items.splice(index,0,result);return result;
                }};
                sheet.tables.items.push(table);return table;
            }};
        sheets.push(sheet);return sheet;
    }
    const context={sync:async()=>{host.syncs++;if(host.beforeSync)await host.beforeSync(host);},workbook:{
        worksheets:{add:addSheet,getItem(id){const s=sheets.find(s=>s.id===id||s.name===id);if(!s)throw new Error('sheet not found');return s;},
            getItemOrNullObject(id){return sheets.find(s=>s.id===id||s.name===id)||{isNullObject:true,load(){}};}},
        settings:{add:(key,value)=>settings.set(key,structuredClone(value)),getItemOrNullObject:key=>({value:settings.get(key),isNullObject:!settings.has(key),load(){}})} }};
    host.Excel={run:fn=>fn(context)};
    host.window={workspaceSheet:{requireExcel(){}},errorMessages:{ADVICE_GROUP_COLUMNS_REQUIRED:'빈도 집계 열 필요'}};
    const sandbox=vm.createContext({window:host.window,Excel:host.Excel,console,Map,Set});
    host.load=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel',file),'utf8'),sandbox);
    host.addSheet=addSheet;host.sheets=sheets;host.settings=settings;host.context=context;
    host.moveColumn=(sheet,from,to)=>{const table=sheet.tables.items[0];table.columns.items.splice(to,0,table.columns.items.splice(from,1)[0]);sheet.cells.forEach(row=>row.splice(to,0,row.splice(from,1)[0]));};
    host.workspace=(headers,rows)=>{
        const sheet=addSheet('조사', [headers,...rows]);const table=sheet.tables.add(range(sheet,0,0,rows.length+1,headers.length));
        return {sheet,table,work:{task_type:'investigation',worksheet_id:sheet.id,sheet_name:sheet.name,table_id:table.id,
            source_row_column_id:table.columns.items[0].id,columns:table.columns.items.slice(1).map(c=>({column_id:c.id,header:c.name,column_index:c.index,role:'reference'}))},target:{row_start:1,row_count:rows.length}};
    };
    ['workspace/table_reader.js','operations/operations_sheet.js','workspace/workspace_copy.js','workspace/source_columns.js'].forEach(host.load);
    return host;
}
module.exports={createInvestigationHost};
