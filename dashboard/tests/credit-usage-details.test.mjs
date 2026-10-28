import assert from 'node:assert/strict';
import test from 'node:test';
import { creditDatabase, seedCredit } from './helpers/credit-database.mjs';
import { loadCreditUsage, loadCreditData } from '../src/lib/server/credit-repository.ts';
import { sumAmounts } from '../src/lib/credit/amounts.ts';
import { buildCreditReport } from '../src/lib/credit/build-report.ts';
import { loadDebtDetail } from '../src/lib/server/financing/debt-detail.js';
import { PostgresDatabase } from '../src/lib/financing/postgres.js';
import { fetchCreditUsage } from '../src/lib/credit/client.ts';

test('credit usage details reconcile exact investor allocations and both lending products with report SQL', async t => {
 const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行');
 await db.exec("INSERT INTO public.client(name,type) VALUES ('甲资管','银行'),('乙银行','银行'); INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes) SELECT i.id,i.name,c.id,'测试关联' FROM credit.institution i CROSS JOIN public.client c WHERE i.name='甲银行' AND c.name='甲资管'");
 const id=(await db.query("INSERT INTO financing.bond(debt_type,subtype,name,amount,issue_date,maturity_date,client_id) SELECT '债券','小公募','共同认购',900000000,'2026-08-21','2027-08-21',id FROM public.client WHERE name='乙银行' RETURNING id")).rows[0].id;
 for(const [name,amount] of [['甲银行','100000001.01'],['甲资管','222000000.02'],['乙银行','300000000']]) await db.query('INSERT INTO financing.bond_investors(bond_id,investor_id,amount) SELECT $1,id,$2 FROM public.client WHERE name=$3',[id,amount,name]);
 for(const [table,type,amount] of [['income_certificate','收益凭证','231000001.01'],['debt','同业拆借','200000000.02']]) await db.query(`INSERT INTO financing.${table}(debt_type,name,amount,activated_at,client_id) SELECT $1,$1,$2,'2026-08-21',id FROM public.client WHERE name='甲银行'`,[type,amount]);
 const report=buildCreditReport(await loadCreditData(db,'2026-08-21'));
 for(const type of ['bond_investment','yield_certificate','interbank_lending']) {
  const detail=await loadCreditUsage(db,'2026-08-21','甲银行',type);
  const item=report.institutions[0].items.find(item=>item.type===type);
  assert.equal(type==='bond_investment' ? detail.totalUsed : sumAmounts([detail.totalUsed]),type==='bond_investment'?item.primaryUsedAmount:item.usedAmount);
  assert.equal(detail.totalCount,type==='bond_investment'?2:1);
  assert.ok(detail.items.every(item=>item.clientName!=='乙银行'));
  assert.deepEqual(Object.keys(detail.items[0]).sort(),['amount','clientName','id','maturityDate','name','startDate']);
 }
 assert.equal((await loadCreditUsage(db,'2026-08-21','甲银行','bond_investment')).totalUsed,3.2200000103);
});

test('usage dates include activation and exclude maturity, settlement and closure days; missing associations remain null', async t => {
 const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行');await seedCredit(db,'2026-08-01','无关联');
 await db.query("DELETE FROM credit.institution_client WHERE institution_name='无关联'");
 for(const [table,type] of [['bond','债券'],['income_certificate','收益凭证'],['debt','同业拆借']]) {
  for(const [suffix,end,settled,closed] of [['到期','2026-08-24',null,null],['结清','2027-08-21','2026-08-24',null],['关闭','2027-08-21',null,'2026-08-24']]) {
   const id=(await db.query(`INSERT INTO financing.${table}(debt_type,subtype,name,amount,issue_date,activated_at,maturity_date,settled_at,closed_at,client_id) SELECT $1,'小公募',$2,100000000,'2026-08-21','2026-08-21',$3,$4,$5,id FROM public.client WHERE name='甲银行' RETURNING id`,[type,type+suffix,end,settled,closed])).rows[0].id;
   if(type==='债券') await db.query('INSERT INTO financing.bond_investors(bond_id,investor_id,amount) SELECT $1,id,100000000 FROM public.client WHERE name=$2',[id,'甲银行']);
  }
 }
 for(const type of ['bond_investment','yield_certificate','interbank_lending']) {
  for(const [date,value,count] of [['2026-08-20',0,0],['2026-08-21',3,3],['2026-08-23',3,3],['2026-08-24',0,0]]) {const result=await loadCreditUsage(db,date,'甲银行',type);assert.equal(result.totalUsed,value);assert.equal(result.totalCount,count);}
  const missing=await loadCreditUsage(db,'2026-08-21','无关联',type);assert.equal(missing.linked,false);assert.equal(missing.totalUsed,null);assert.deepEqual(missing.items,[]);
 }
 await assert.rejects(loadCreditUsage(db,'2026-08-21','不存在','bond_investment'),error=>error.status===404);
});

test('usage pagination retains full numeric sum and stable pages', async t=>{
 const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行');
 await db.exec("INSERT INTO financing.debt(debt_type,name,amount,activated_at,client_id) SELECT '同业拆借','拆借'||n,100000001.01,'2026-08-21',c.id FROM generate_series(1,105) n CROSS JOIN public.client c WHERE c.name='甲银行'");
 const first=await loadCreditUsage(db,'2026-08-21','甲银行','interbank_lending');const second=await loadCreditUsage(db,'2026-08-21','甲银行','interbank_lending',100);
 assert.equal(first.totalCount,105);assert.equal(first.totalUsed,105.0000010605);assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(second.totalUsed,first.totalUsed);assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,105);
});

test('existing debt detail query reaches all seven debt classes, including inherited specialist fields and cashflows', async t=>{
 const db=await creditDatabase(t);
 const adapter=new PostgresDatabase('unused');adapter.query=(sql,values)=>db.query(sql,values);
 for(const [table,type,extra] of [['bond','债券',"subtype,receiving_account"],['income_certificate','收益凭证',"subtype,receiving_account"],['income_right','收益权转让',"subtype,interest_basis_days"],['refinancing','转融资',"subtype,interest_basis_days"],['swap_facility','互换便利',"subtype,average_repo_balance_description"],['debt','集团借款',"subtype,counterparty"],['debt','同业拆借',"subtype,counterparty"]]) {
  const value=extra.includes('interest_basis')?'365':"'专属字段'";
  const id=(await db.query(`INSERT INTO financing.${table}(debt_type,name,amount,issue_date,maturity_date,${extra}) VALUES ($1,$1,100000000,'2026-08-21','2027-08-21','小公募',${value}) RETURNING id`,[type])).rows[0].id;
  await db.query("INSERT INTO financing.cashflow(debt_id,sequence,cashflow_type,due_date,amount) VALUES ($1,1,'principal','2027-08-21',100000000)",[id]);
  const detail=await loadDebtDetail(adapter,String(id));assert.equal(detail.debtType,type);assert.equal(detail.amount,100000000);assert.equal(detail.cashflows.length,1);assert.equal(detail.cashflows[0].amount,100000000);
  if(table==='bond'||table==='income_certificate') assert.equal(detail.receivingAccount,'专属字段');
  if(table==='income_right'||table==='refinancing') assert.equal(detail.interestBasisDays,365);
 }
 assert.equal(await loadDebtDetail(adapter,'999999'),null);assert.equal(await loadDebtDetail(adapter,'invalid'),null);
});

test('usage client validates requested context and prevents malformed details',async()=>{
 const result={reportDate:'2026-08-21',institutionName:'甲银行',type:'bond_investment',linked:true,totalUsed:0,totalCount:0,offset:0,items:[]};
 const fetcher=async()=>Response.json(result);assert.deepEqual(await fetchCreditUsage(result.reportDate,result.institutionName,result.type,0,fetcher),result);
 await assert.rejects(fetchCreditUsage('2026-08-22','甲银行',result.type,0,fetcher),/数据无效/);
});

test('usage client rejects null payloads and non-object rows with a controlled validation error',async()=>{
 for(const payload of [null,{reportDate:'2026-08-21',institutionName:'甲银行',type:'bond_investment',linked:true,totalUsed:1,totalCount:1,offset:0,items:[null]}])
  await assert.rejects(fetchCreditUsage('2026-08-21','甲银行','bond_investment',0,async()=>Response.json(payload)),/融资条目数据无效/);
});

test('credit GET usage validates inputs before opening a connection and keeps report GET unchanged',async()=>{
 const { createRequire }=await import('node:module');const { readFile }=await import('node:fs/promises');
 const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
 const calls=[];globalThis.__usageTestCalls=calls;
 const code=(await build({stdin:{contents:await readFile(new URL('../src/routes/api/credit/+server.ts',import.meta.url),'utf8'),resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'credit-route-fixture',setup(plugin){
  plugin.onResolve({filter:/^\$lib\//},args=>({path:args.path,namespace:'fixture'}));
  plugin.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('postgres') ? `export async function withPostgres(connection,name,fn) {globalThis.__usageTestCalls.push(['connect']);return fn({query:async(sql)=>{globalThis.__usageTestCalls.push([sql]);return {rows:[]}}})}`
   : args.path.includes('credit-masked') ? `export async function loadCreditMasked(){throw new Error('AI path must not run for report/usage')}`
   : args.path.endsWith('/credit/masked.ts') ? `export const creditMaskedQuerySchema={safeParse:()=>({success:true})}`
   : args.path.includes('credit-repository') ? `export class CreditDatabaseError extends Error{};export async function loadCreditUsage(...args){globalThis.__usageTestCalls.push(['usage',...args.slice(1)]);return {items:[]}};export async function loadCreditData(){globalThis.__usageTestCalls.push(['report']);return {report:true}};export function saveCreditInstitution(){}`
   : args.path.includes('bond-ledger') ? `export class BondLedgerUploadError extends Error{};export function validateSameOrigin(){}` : `export const creditInstitutionUpdateSchema={parse:value=>value};`}));
 }}]})).outputFiles[0].text;
 const {GET}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 for(const query of ['view=other','view=usage','view=usage&date=2026-02-30&institution=甲银行&type=bond_investment','view=usage&date=2026-08-21&institution=甲银行&type=other','view=usage&date=2026-08-21&institution=甲银行&type=bond_investment&offset=-1','view=usage&date=2026-08-21&institution=甲银行&type=bond_investment&offset=100001']){
  assert.equal((await GET({url:new URL('https://test/api/credit?'+query),platform:{env:{}}})).status,400);assert.equal(calls.length,0);
 }
 const response=await GET({url:new URL('https://test/api/credit?view=usage&date=2026-08-21&institution=甲银行&type=bond_investment&offset=100'),platform:{env:{}}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(calls.find(c=>c[0]==='usage'),['usage','2026-08-21','甲银行','bond_investment',100]);
 calls.length=0;assert.equal((await GET({url:new URL('https://test/api/credit?date=2026-08-21'),platform:{env:{}}})).status,200);assert.ok(calls.some(c=>c[0]==='report'));delete globalThis.__usageTestCalls;
});
