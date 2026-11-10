// Office API contract double; real Excel calculation still needs an integration check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function letters(index) {
    let text = '';
    for (index++; index; index = Math.floor((index - 1) / 26)) text = String.fromCharCode(65 + (index - 1) % 26) + text;
    return text;
}
function bounds(address) {
    const parts = address.replace(/^.*!/, '').replace(/\$/g, '').split(':');
    function cell(text) {
        const match = /^([A-Z]+)(\d+)$/.exec(text);
        return [+match[2]-1, [...match[1]].reduce((n, c) => n*26+c.charCodeAt(0)-64, 0)-1];
    }
    const [row, col] = cell(parts[0]), [endRow, endCol] = cell(parts[1] || parts[0]);
    return [row, col, endRow-row+1, endCol-col+1];
}
function translate(formula, dr, dc) {
    return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (_, fixedCol, col, fixedRow, row) => {
        const c = bounds(col+row)[1];
        return fixedCol+letters(c+(fixedCol ? 0 : dc))+fixedRow+(+row+(fixedRow ? 0 : dr));
    });
}
function createHost({rows=90000, sourceColumns=2, tableColumns, data}={}) {
    const pending = [], writes = [], loads = [], occupied = new Map();
    const host = {writes, loads, occupied, rows, syncs: 0, beforeSync: null, errorRow: -1};
    const intersects = (a,b) => a.r < b.r+b.n && a.r+a.n > b.r && a.c < b.c+b.m && a.c+a.m > b.c;
    const context = {sync: async () => {
        host.syncs++;
        if (host.beforeSync) host.beforeSync(host);
        for (const action of pending.splice(0)) action();
    }};
    function formulaAt(r,c) {
        for (let i=writes.length-1;i>=0;i--) {
            const w=writes[i];
            if (r>=w.r && r<w.r+w.n && c===w.c) return translate(w.formula,r-w.r,0);
        }
        const x=occupied.get(r+','+c);
        return x && x.formula || '';
    }
    host.formulaAt = formulaAt;
    function range(r,c,n,m) {
        const x={r,c,n,m,rowIndex:r,columnIndex:c,rowCount:n,columnCount:m,
            address:'Sheet1!'+letters(c)+(r+1)+(n===1&&m===1?'':':'+letters(c+m-1)+(r+n)),
            worksheet:null,
            load(properties) {
                loads.push({properties,r,c,n,m});
                if (/\b(text|values|formulas|valueTypes)\b/.test(properties)) assert(n*m<=20000,'unbounded cell read');
                pending.push(() => {
                    for (const prop of properties.split(',')) {
                        if (['text','values','formulas','valueTypes'].includes(prop)) {
                            x[prop]=Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=> {
                                if (prop==='valueTypes') return r+i===host.errorRow?'Error':'String';
                                const existing=occupied.get((r+i)+','+(c+j));
                                if (prop==='formulas') return formulaAt(r+i,c+j);
                                if (data) return data(r+i,c+j);
                                return existing ? existing.value||'' : '#literal';
                            }));
                        }
                    }
                }); return x;
            },
            getSpecialCellsOrNullObject(kind) {
                const result={};
                pending.push(()=>{
                    const explicit=[...occupied].some(([key, cell])=>{
                        const [rr,cc]=key.split(',').map(Number);
                        return rr>=r && rr<r+n && cc>=c && cc<c+m &&
                            (kind==='Formulas'?!!cell.formula:cell.value!==undefined && cell.value!=='');
                    });
                    result.isNullObject=!(explicit || kind==='Formulas' && writes.some(w=>intersects(x,{...w,m:1})));
                }); return result;
            },
            getCell(i,j){return range(r+i,c+j,1,1);},
            getResizedRange(i,j){return range(r,c,n+i,m+j);},
            autoFill(destination,type) {
                assert.equal(type,'FillCopy'); const d=typeof destination==='string'?sheet.getRange(destination):destination;
                assert(d.n<=1000);
                pending.push(()=>writes.push({r:d.r,c:d.c,n:d.n,formula:translate(formulaAt(r,c),d.r-r,d.c-c)}));
            },
            copyFrom(source,type) {
                assert.equal(type,'Formulas'); assert(n<=1000);
                pending.push(()=>writes.push({r,c,n,formula:translate(formulaAt(source.r,source.c),r-source.r,c-source.c)}));
            },
            calculate(){assert(n<=1000);},
        };
        Object.defineProperty(x,'formulas',{set(value){assert.equal(value.length,1);pending.push(()=>writes.push({r,c,n:1,formula:value[0][0]}));},get(){return [[formulaAt(r,c)]];}, configurable:true});
        x.worksheet=sheet;
        return x;
    }
    const sheet={id:'sheet',name:'Sheet1',load(){},getRange:address=>range(...bounds(address)),
        getRangeByIndexes:range, getUsedRange:()=>range(0,0,rows+1,sourceColumns)};
    const selection=range(1,0,rows,sourceColumns);
    context.workbook={worksheets:{getItem:()=>sheet},getSelectedRange:()=>host.selected||selection};
    if (tableColumns) {
        const items=tableColumns.map((name,index)=>({id:String(index),name,index}));
        const table={getDataBodyRange:()=>range(1,0,rows,items.length),columns:{items,load(){}}};
        sheet.tables={getItem:()=>table};
    }
    const sandbox={window:{workspaceSheet:{requireExcel(){}}},Office:{context:{requirements:{isSetSupported:()=>true}}},
        Excel:{run:fn=>fn(context)},console,Map,Set};
    vm.createContext(sandbox);
    sandbox.window.errorMessages=JSON.parse(fs.readFileSync(path.join(__dirname,'../../src/services/error_messages.json'),'utf8'));
    host.load=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/static/excel',file),'utf8'),sandbox);
    host.window=sandbox.window; host.range=range;
    host.selection={worksheet_id:'sheet',sheet_name:'Sheet1',address:selection.address,row_start:1,column_start:0,row_count:rows,column_count:sourceColumns};
    return host;
}
module.exports={createHost,translate};
