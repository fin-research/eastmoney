import assert from 'node:assert/strict';
import test from 'node:test';
import { creditDatabase, seedCredit, applyCreditMigration } from './helpers/credit-database.mjs';
import { loadCreditReport } from '../src/lib/server/credit-repository.ts';

const migration='0021_correct_agricultural_bank_renewal.sql';
const name='农业银行&农银理财';

test('Agricultural Bank correction keeps the existing line and creation provenance, classifies renewal, and clears the new count',async t=>{
 const db=await creditDatabase(t);
 await seedCredit(db,'2026-08-21',name,{total:120,status:'applying',effective_date:'2025-07-31',expiry_date:'2026-07-23'});
 await seedCredit(db,'2026-08-28',name,{total:120,effective_date:'2026-08-25',expiry_date:'2027-08-25',verified:true},'new');
 const rows=async()=>(await db.query(`SELECT e.*,e.report_date::text AS report_date FROM credit.entry e JOIN credit.institution i ON i.id=e.institution_id WHERE i.name=$1 ORDER BY e.report_date,e.field_id`,[name])).rows;
 const before=await rows();
 assert.equal(before.filter(row=>row.report_date==='2026-08-28').length,3);
 assert.equal((await loadCreditReport(db,'2026-08-28')).weeklySummary.addedInstitutionCount,1);
 // The fixture database already installed the migration before this institution existed.
 await db.query('DELETE FROM credit.schema_migration WHERE name=$1',[migration]);
 await applyCreditMigration(db,migration);
 const after=await rows();
 assert.deepEqual(after.map(({event,updated_at,...row})=>row),before.map(({event,updated_at,...row})=>row));
 assert.ok(after.filter(row=>row.report_date==='2026-08-28').every(row=>row.event==='renewal' && row.updated_at));
 assert.deepEqual(after.filter(row=>row.report_date==='2026-08-21'),before.filter(row=>row.report_date==='2026-08-21'));
 const report=await loadCreditReport(db,'2026-08-28');
 assert.equal(report.weeklySummary.addedInstitutionCount,0);
 assert.deepEqual(report.weeklyNews.map(row=>row.eventType),['renewal']);
 assert.deepEqual(report.recentApprovals.map(row=>row.eventType),['renewal']);
 assert.equal(report.institutions[0].totalLimit,120);
});

test('Agricultural Bank correction rejects an unreviewed baseline without changing entries',async t=>{
 const db=await creditDatabase(t);
 await seedCredit(db,'2026-08-21',name,{total:121,status:'applying',effective_date:'2025-07-31',expiry_date:'2026-07-23'});
 const before=(await db.query('SELECT * FROM credit.entry ORDER BY field_id')).rows;
 await assert.rejects(applyCreditMigration(db,migration),/Unexpected Agricultural Bank baseline/);
 assert.deepEqual((await db.query('SELECT * FROM credit.entry ORDER BY field_id')).rows,before);
});
