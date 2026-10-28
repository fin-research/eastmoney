import assert from 'node:assert/strict';
import test from 'node:test';
import { creditDatabase, seedCredit } from './helpers/credit-database.mjs';
import { saveCreditInstitution, loadCreditReport } from '../src/lib/server/credit-repository.ts';
import { buildCreditReport } from '../src/lib/credit/build-report.ts';
import { creditInstitutionUpdateSchema } from '../src/lib/credit/update.ts';
import { toCreditImportPatch } from '../src/lib/credit/entry.ts';

test('report-day verification is explicit, idempotent, and isolated from later snapshots',async t=>{
 const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{expiry_date:'2027-12-31',notes:'原备注'});
 const save=changes=>saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-30',institutionName:'甲银行',changes:{institution:changes}},'auth0|verified');
 const rows=async()=>(await db.query("SELECT field_id,verified,v_text,created_by,created_at::text,updated_at::text,event FROM credit.entry WHERE report_date='2026-09-30' ORDER BY field_id")).rows;
 await save({verified:false});assert.deepEqual(await rows(),[]);
 let response=await save({verified:true});assert.equal(buildCreditReport(response.data).institutions[0].verified,true);
 const before=await rows();assert.equal(before.length,1);assert.equal(before[0].v_text,'原备注');assert.equal(before[0].event,'maintenance');
 await save({verified:true});assert.deepEqual(await rows(),before);
 await save({detail:'更新额度说明'});assert.ok((await rows()).every(r=>r.verified));
 response=await save({verified:false});assert.equal(buildCreditReport(response.data).institutions[0].verified,false);
 assert.ok((await rows()).every(r=>!r.verified));
 assert.equal((await rows())[0].created_by,before[0].created_by);
 await save({verified:true});
 for(const date of ['2026-09-29','2026-10-01','2026-12-31'])assert.equal((await loadCreditReport(db,date)).institutions[0].verified,false);
 const report=await loadCreditReport(db,'2026-09-30');assert.equal(report.institutions[0].verified,true);
 assert.equal(report.calendarEvents.some(e=>['new','amendment','usage'].includes(e.kind)),false);
 const committed=await rows();await db.exec('BEGIN');
 await assert.rejects(db.query("SELECT credit.append_entry('2026-09-30','甲银行','{\"verified\":false,\"expiry_date\":\"2025-01-01\"}',NULL)"),/expiry precedes/);
 await db.exec('ROLLBACK');assert.deepEqual(await rows(),committed);
 for(const value of ['null','1','"true"'])await assert.rejects(db.query(`SELECT credit.append_entry('2026-09-30','甲银行','{"verified":${value}}',NULL)`),/must be boolean/);
});

test('verified input accepts only booleans and imports never reset the manual flag',()=>{
 for(const verified of [null,'true',1])assert.equal(creditInstitutionUpdateSchema.safeParse({operation:'maintenance',reportDate:'2026-09-30',institutionName:'甲银行',changes:{institution:{verified}}}).success,false);
 assert.equal('verified' in toCreditImportPatch({items:[],verified:true}),false);
});

test('migration plans keep cutover explicit and permit later migrations only after finalized ledgers',async()=>{
 const {creditMigrationPlan}=await import('../scripts/credit-migration-plan.mjs');
 const names=['0018_credit_entries.sql','0019_finalize_credit_entries.sql','0020_credit_verified.sql'];
 assert.deepEqual(creditMigrationPlan(names,new Set()),[names[0]]);
 assert.deepEqual(creditMigrationPlan(names,new Set([names[0]])),[names[0]]);
 assert.deepEqual(creditMigrationPlan(names,new Set(names.slice(0,2))),[names[0],names[2]]);
 assert.deepEqual(creditMigrationPlan(names,new Set(),true),names);
});
