import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCreditInstitutions, cycleCreditSort, defaultCreditSort } from '../src/lib/credit/sorting.ts';
const row=(institutionName,institutionType,totalLimit,extra={})=>({institutionName,institutionType,totalLimit,...extra});
const names=(rows,sorts=defaultCreditSort)=>[...rows].sort((a,b)=>compareCreditInstitutions(a,b,sorts)).map(r=>r.institutionName);
test('default sorting uses category before descending limit and names only for ties',()=>{
 assert.deepEqual(names([row('银行甲','股份行',1),row('银行乙','股份行',20),row('银行丙','政策性银行',2),row('银行丁','城商行',50)]),['银行丙','银行乙','银行甲','银行丁']);
 const tied=[row('银行2','股份行',10),row('银行1','股份行',10)];
 assert.deepEqual(names(tied),['银行1','银行2']);
});
test('sort keys cycle without replacing or reordering other priorities',()=>{
 let sorts=cycleCreditSort(defaultCreditSort,'totalUsed');
 assert.deepEqual(sorts,[...defaultCreditSort,{key:'totalUsed',direction:'ascending'}]);
 sorts=cycleCreditSort(sorts,'totalUsed');assert.equal(sorts[2].direction,'descending');
 assert.deepEqual(cycleCreditSort(sorts,'totalUsed'),defaultCreditSort);
 assert.deepEqual(cycleCreditSort(defaultCreditSort,'totalLimit'),[defaultCreditSort[0]]);
});
test('missing values stay last in both directions while tied values reach subsequent keys',()=>{
 const rows=[row('缺失','股份行',null),row('零','股份行',0),row('十','股份行',10),row('同额','股份行',10,{totalUsed:2})];
 assert.deepEqual(names(rows),['十','同额','零','缺失']);
 assert.equal(names(rows,[{key:'totalLimit',direction:'ascending'}]).at(-1),'缺失');
 assert.deepEqual(names(rows,[...defaultCreditSort,{key:'totalUsed',direction:'descending'}]),['同额','十','零','缺失']);
 assert.deepEqual(names([row('银行2','城商行',50),row('银行1','股份行',0)],[]),['银行1','银行2']);
});
