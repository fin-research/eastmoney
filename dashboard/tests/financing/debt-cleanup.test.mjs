import test from 'node:test';
import assert from 'node:assert/strict';
import {isCleanupCandidate} from '../../scripts/financing/cleanup-debt-narratives.mjs';
import {importDebtWorkbook} from '../../src/lib/server/financing/debt-importer.js';

test('cleanup selects only empty bond notes and keeps business fields, other types and real instruments',()=>{
 const row={physical_table:'financing.bond',data:{id:1,name:'发行阶段：',debt_type:'债券',subtype:'小公募',amount:0,interest_payable:0,issue_date:null,client_id:null,bookrunner:null}};
 assert.equal(isCleanupCandidate(row),true);
 for(const change of [{amount:1},{interest_payable:1},{issue_date:'2026-01-01'},{client_id:2},{bookrunner:'真实承销商'},{name:'真实债券'},{name:'1、计划产品'},{name:'1、真实债券',maturity_date:'2027-01-01'}])assert.equal(isCleanupCandidate({...row,data:{...row.data,...change}}),false);
 assert.equal(isCleanupCandidate({...row,physical_table:'financing.debt'}),false);
});

test('atomic CLI importer rolls back rejected narrative rows before insertion',async()=>{
 const calls=[];const db={query:async(sql)=>{calls.push(sql);return {rows:[{version:'v1'}]};}};
 await assert.rejects(importDebtWorkbook(db,{snapshot:{asOfDate:'2026-10-16',totalYi:0},debts:[{debtType:'债券',name:'发行阶段：',amount:0,interestPayable:0}]}),/说明文字不能作为负债/);
 assert.equal(calls.at(-1),'ROLLBACK');assert.ok(!calls.some(sql=>sql.includes('INSERT INTO financing.')));
});
