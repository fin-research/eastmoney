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

const zhongshan='中山农商行';
async function zhongshanBeforeCorrection(t) {
 const db=await creditDatabase(t,false,false,false,true);
 for(const migration of ['0018_credit_entries.sql','0019_finalize_credit_entries.sql','0020_credit_verified.sql',
   '0021_correct_agricultural_bank_renewal.sql','0022_credit_ai_ledger.sql','0023_credit_masked.sql']) {
  await applyCreditMigration(db,migration);
 }
 await seedCredit(db,'2026-08-21',zhongshan,{total:9,effective_date:'2025-10-21',expiry_date:'2026-10-21'});
 await db.query("SELECT credit.append_entry('2026-10-30',$1,'{\"effective_date\":\"2026-10-21\",\"expiry_date\":\"2027-10-21\"}'::jsonb,'auth0|test','new')",[zhongshan]);
 return db;
}

test('Zhongshan correction preserves renewal values and authorship and removes the new event count',async t=>{
 const db=await zhongshanBeforeCorrection(t);
 const rows=async()=>(await db.query(`SELECT e.*,e.report_date::text AS report_date FROM credit.entry e JOIN credit.institution i ON i.id=e.institution_id WHERE i.name=$1 ORDER BY e.report_date,e.field_id`,[zhongshan])).rows;
 const before=await rows();
 assert.equal(before.filter(row=>row.report_date==='2026-10-30').length,2);
 assert.equal((await loadCreditReport(db,'2026-10-30')).weeklySummary.addedInstitutionCount,1);
 await applyCreditMigration(db,'0024_credit_history_correction.sql');
 const after=await rows();
 assert.deepEqual(after.map(({event,updated_at,...row})=>row),before.map(({event,updated_at,...row})=>row));
 assert.ok(after.filter(row=>row.report_date==='2026-10-30').every(row=>row.event==='renewal'));
 assert.deepEqual(after.filter(row=>row.report_date==='2026-08-21'),before.filter(row=>row.report_date==='2026-08-21'));
 const report=await loadCreditReport(db,'2026-10-30');
 assert.equal(report.weeklySummary.addedInstitutionCount,0);
 assert.deepEqual(report.weeklyNews.map(row=>row.eventType),['renewal']);
 assert.deepEqual(report.recentApprovals.map(row=>row.eventType),['renewal']);
 assert.equal(report.institutions[0].totalLimit,9);
});

test('Zhongshan correction rejects a drifted baseline and rolls back its migration',async t=>{
 const db=await zhongshanBeforeCorrection(t);
 await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_num=10 WHERE institution_id=(SELECT id FROM credit.institution WHERE name='中山农商行') AND field_id='total' AND report_date='2026-08-21'; COMMIT");
 const before=(await db.query("SELECT * FROM credit.entry WHERE institution_id=(SELECT id FROM credit.institution WHERE name=$1) ORDER BY report_date,field_id",[zhongshan])).rows;
 await assert.rejects(applyCreditMigration(db,'0024_credit_history_correction.sql'),/Unexpected Zhongshan Rural Commercial Bank baseline/);
 assert.deepEqual((await db.query("SELECT * FROM credit.entry WHERE institution_id=(SELECT id FROM credit.institution WHERE name=$1) ORDER BY report_date,field_id",[zhongshan])).rows,before);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM credit.schema_migration WHERE name='0024_credit_history_correction.sql'")).rows[0].n,0);
});
