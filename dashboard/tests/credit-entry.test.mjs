import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {creditDatabase,seedCredit,applyCreditMigration} from './helpers/credit-database.mjs';
import {loadCreditReport,saveCreditInstitution} from '../src/lib/server/credit-repository.ts';

test('typed long entries enforce the composite key, one value, metric type and monetary range',async t=>{
  const db=await creditDatabase(t);await seedCredit(db);
  const id=(await db.query('SELECT id FROM credit.institution')).rows[0].id;
  await assert.rejects(db.query("INSERT INTO credit.entry(report_date,field_id,institution_id,v_num,v_text) VALUES('2026-08-22','total',$1,1,'x')",[id]),/check constraint/);
  await assert.rejects(db.query("INSERT INTO credit.entry(report_date,field_id,institution_id,v_text) VALUES('2026-08-22','total',$1,'x')",[id]),/type mismatch/);
  await assert.rejects(db.query("INSERT INTO credit.entry(report_date,field_id,institution_id,v_num) VALUES('2026-08-22','total',$1,-1)",[id]),/check constraint/);
  await assert.rejects(db.query("INSERT INTO credit.entry(report_date,field_id,institution_id,v_num) VALUES('2026-08-21','total',$1,1)",[id]),/unique constraint/);
  await assert.rejects(db.query("UPDATE credit.metric SET type='text' WHERE id='total'"),/type cannot change/);
  await assert.rejects(db.query("DELETE FROM credit.entry"),/cannot be deleted/);
});

test('metadata is a single state across dates and renaming preserves institution and client identity',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{handler:'原经办人'});
  const before=(await db.query('SELECT id FROM credit.institution')).rows[0].id;
  const count=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-08-22',institutionName:'甲银行',changes:{institution:{handler:'新经办人',confidentialityStatus:true}}});
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,count);
  assert.equal((await loadCreditReport(db,'2026-08-21')).institutions[0].handler,'新经办人');
  await db.query("UPDATE credit.institution SET name='甲银行新名称' WHERE id=$1",[before]);
  const report=await loadCreditReport(db,'2026-08-22');
  assert.equal(report.institutions[0].institutionName,'甲银行新名称');assert.equal(report.summary.totalUsed,3);
  assert.equal((await db.query('SELECT institution_id,institution_name FROM credit.institution_client')).rows[0].institution_id,before);
  assert.equal((await db.query('SELECT institution_id,institution_name FROM credit.institution_client')).rows[0].institution_name,'甲银行新名称');
  await seedCredit(db,'2026-08-21','乙银行');
  await assert.rejects(db.query("UPDATE credit.institution_client SET institution_name='乙银行' WHERE institution_id=$1",[before]),/foreign key constraint/);
});

test('explicit revocation is excluded from every business collection without erasing earlier views',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{expiry_date:'2027-08-21'},'new');
  await saveCreditInstitution(db,{operation:'revocation',reportDate:'2026-08-22',institutionName:'甲银行',changes:{institution:{status:'revoked'}}});
  assert.equal((await loadCreditReport(db,'2026-08-21')).summary.approvedCount,1);
  const report=await loadCreditReport(db,'2026-08-22');
  assert.equal(report.summary.institutionCount,0);assert.equal(report.summary.totalLimit,0);
  for(const field of ['institutions','weeklyNews','recentApprovals','limitChanges','usageChanges','calendarEvents'])assert.deepEqual(report[field],[]);
  assert.equal((await db.query("SELECT expiry_date::text FROM credit.entry_as_of('2026-08-22')")).rows[0].expiry_date,'1970-01-01');
  await db.query("SELECT credit.append_entry('2026-08-23','甲银行','{\"status\":\"approved\",\"expiry_date\":\"2028-08-23\"}',NULL,'new')");
  assert.equal((await loadCreditReport(db,'2026-08-23')).summary.approvedCount,1);
  assert.equal((await loadCreditReport(db,'2026-08-22')).summary.approvedCount,0);
});

test('additive migration keeps existing revocations exact, drains old writes, and fences new writes until finalization',async t=>{
  const db=await creditDatabase(t,false,false,false,true);
  await seedCredit(db,'2026-08-21','正常机构',{handler:'当前人',expiry_date:'2027-08-21'});
  await seedCredit(db,'2026-08-21','原撤销',{status:'revoked',expiry_date:null,effective_date:null});
  await seedCredit(db,'2026-08-21','无日期批准',{expiry_date:null,effective_date:null});
  await applyCreditMigration(db,'0018_credit_entries.sql');
  const state=async name=>(await db.query("SELECT status,expiry_date::text FROM credit.entry_as_of('2026-08-22',ARRAY[$1])",[name])).rows[0];
  assert.deepEqual(await state('原撤销'),{status:'revoked',expiry_date:'1970-01-01'});
  assert.deepEqual(await state('正常机构'),{status:'approved',expiry_date:'2027-08-21'});
  assert.deepEqual(await state('无日期批准'),{status:'approved',expiry_date:null});
  await assert.rejects(db.query("SELECT credit.append_entry('2026-08-22','正常机构','{\"notes\":\"新应用\"}',NULL)"),/await cutover/);
  await assert.rejects(db.query("UPDATE credit.institution SET name='改名' WHERE name='正常机构'"),/rename awaits cutover/);
  await db.query("SELECT credit.append_diff('2026-08-22','正常机构','{\"total\":12,\"notes\":\"旧应用\"}',NULL,'increase')");
  await db.query("SELECT credit.append_diff('2026-08-22','正常机构','{\"notes\":\"同日维护\"}',NULL)");
  assert.equal(Number((await db.query("SELECT total FROM credit.entry_as_of('2026-08-22',ARRAY['正常机构'])")).rows[0].total),12);
  assert.deepEqual((await db.query("SELECT DISTINCT event FROM credit.entry WHERE report_date='2026-08-22'")).rows,[{event:'increase'}]);
  await db.query("INSERT INTO public.client(name,type) VALUES('旧应用新建','银行')");
  await db.query("SELECT credit.append_diff('2026-08-22','旧应用新建','{\"institution_type\":\"城商行\",\"status\":\"approved\",\"confidentiality_status\":false,\"total\":8}',NULL,'new')");
  assert.equal((await db.query("SELECT count(*) n FROM credit.institution_client WHERE institution_name='旧应用新建'")).rows[0].n,1);
  await db.query("SELECT credit.append_diff('2026-08-23','正常机构','{\"status\":\"revoked\"}',NULL,'revocation')");
  await db.query("SELECT credit.append_diff('2026-08-24','正常机构','{\"status\":\"approved\"}',NULL,'new')");
  assert.equal((await db.query("SELECT status FROM credit.entry_as_of('2026-08-24',ARRAY['正常机构'])")).rows[0].status,'approved');
  await assert.rejects(db.query("SELECT credit.append_diff('2026-08-24','原撤销','{\"status\":\"approved\"}',NULL,'new')"),/requires an expiry date/);
  assert.equal((await db.query("SELECT status FROM credit.state_as_of('2026-08-24',ARRAY['原撤销'])")).rows[0].status,'revoked');
  assert.equal((await db.query("SELECT status FROM credit.entry_as_of('2026-08-24',ARRAY['原撤销'])")).rows[0].status,'revoked');
  // Dated view states can hide a corrupted underlying manual status. Reconcile
  // that raw status independently instead of comparing the derived view only.
  await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_text='applying' WHERE institution_id=(SELECT id FROM credit.institution WHERE name='正常机构') AND field_id='status' AND report_date='2026-08-21'; COMMIT");
  await assert.rejects(db.query('SELECT credit.verify_entry_migration()'),/historical value reconciliation failed/);
  await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_text='approved' WHERE institution_id=(SELECT id FROM credit.institution WHERE name='正常机构') AND field_id='status' AND report_date='2026-08-21'; COMMIT");
  // Final reconciliation detects any stale mirrored business value and rolls back
  // the cutover, preserving the still-running old worker's read/write functions.
  await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_num=99 WHERE institution_id=(SELECT id FROM credit.institution WHERE name='正常机构') AND field_id='total' AND report_date='2026-08-22'; COMMIT");
  await assert.rejects(applyCreditMigration(db,'0019_finalize_credit_entries.sql'),/historical value reconciliation failed/);
  assert.ok((await db.query("SELECT to_regclass('credit.diff') AS name")).rows[0].name);
  await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_num=12 WHERE institution_id=(SELECT id FROM credit.institution WHERE name='正常机构') AND field_id='total' AND report_date='2026-08-22'; COMMIT");
  await applyCreditMigration(db,'0019_finalize_credit_entries.sql');
  await db.query("SELECT credit.append_entry('2026-08-22','正常机构','{\"notes\":\"新应用接管\"}',NULL)");
  await assert.rejects(db.query("SELECT credit.append_diff('2026-08-22','正常机构','{}',NULL)"),/does not exist/);
  await assert.rejects(db.query("UPDATE credit.legacy_diff SET notes='旧程序'"),/read only/);
  assert.equal((await db.query("SELECT notes FROM credit.entry_as_of('2026-08-22',ARRAY['正常机构'])")).rows[0].notes,'新应用接管');
});

test('a reader retains SELECT without gaining entry writes or append permissions',async t=>{
  const db=await creditDatabase(t,false,false,false,true);await seedCredit(db);
  await db.exec('CREATE ROLE credit_reader; GRANT USAGE ON SCHEMA credit TO credit_reader; GRANT SELECT ON credit.diff TO credit_reader');
  await applyCreditMigration(db,'0018_credit_entries.sql');
  const rights=(await db.query("SELECT has_table_privilege('credit_reader','credit.entry','SELECT') AS read,has_table_privilege('credit_reader','credit.entry','INSERT') AS write,has_function_privilege('credit_reader','credit.append_entry(date,text,jsonb,text,credit.entry_event)','EXECUTE') AS append")).rows[0];
  assert.deepEqual(rights,{read:true,write:false,append:false});
});

test('migration runner cannot remove old write endpoints through its default command',()=>{
  const script=fs.readFileSync(new URL('../scripts/apply-credit-migrations.mjs',import.meta.url),'utf8');
  assert.match(script,/process\.argv\.includes\('--finalize'\)/);
  assert.match(script,/creditMigrationPlan\(migrationNames, appliedNames, finalize\)/);
});
