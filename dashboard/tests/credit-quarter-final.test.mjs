import {buildCreditReport} from '../src/lib/credit/build-report.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { creditQuarterDates, isCreditFinalized } from '../src/lib/credit/report-date.ts';
import { creditDatabase, seedCredit, applyCreditMigration } from './helpers/credit-database.mjs';
import { loadCreditReport, saveCreditInstitution } from '../src/lib/server/credit-repository.ts';

test('finalized badges require explicit verification on each quarter end', () => {
  for (const date of ['2026-03-31','2026-06-30','2026-09-30','2026-12-31']) {
    assert.equal(isCreditFinalized({verified:true},date),true);
    assert.equal(isCreditFinalized({verified:false},date),false);
    assert.equal(isCreditFinalized({},date),false);
  }
  assert.equal(isCreditFinalized({verified:true},'2026-10-09'),false);
  assert.deepEqual(creditQuarterDates(2026,'2026-08-21'),[
    {date:'2026-09-30',label:'26Q3'},{date:'2026-12-31',label:'26Q4'},
  ]);
  assert.equal(creditQuarterDates(2027,'2026-08-21').length,4);
});

test('backfilled explicit verification marks its report day and PATCH and GET agree', async t => {
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-21','甲银行',{expiry_date:'2027-12-31'});
  await seedCredit(db,'2026-08-21','乙银行',{expiry_date:'2027-12-31'});
  assert.equal(isCreditFinalized((await loadCreditReport(db,'2026-09-30')).institutions[0],'2026-09-30'),false);
  const saved=await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-30',viewDate:'2026-09-30',calendarMonth:'2026-09',institutionName:'甲银行',changes:{institution:{notes:'季末确认',verified:true}}},'auth0|test');
  assert.equal(buildCreditReport(saved.data).institutions[0].lastChangedOn,'2026-09-30');
  assert.equal(isCreditFinalized(buildCreditReport(saved.data).institutions[0],'2026-09-30'),true);
  assert.equal(buildCreditReport(saved.data).calendarEvents.some(e=>e.kind==='amendment'),false);
  const report=await loadCreditReport(db,'2026-09-30');
  assert.deepEqual(report.institutions.map(row=>[row.institutionName,isCreditFinalized(row,'2026-09-30')]).sort(),[['乙银行',false],['甲银行',true]].sort());
  assert.equal((await loadCreditReport(db,'2026-09-29')).institutions.find(row=>row.institutionName==='甲银行').lastChangedOn,'2026-08-21');
  assert.equal((await loadCreditReport(db,'2026-10-01')).institutions.find(row=>row.institutionName==='甲银行').lastChangedOn,'2026-09-30');
});

test('archive removal preserves facts, same-day identity and transaction rollback', async t => {
  const db=await creditDatabase(t,false,false,true);
  await seedCredit(db,'2026-08-21');
  for (const name of ['0013_explicit_credit_applications.sql','0014_retire_credit_item_fields.sql','0015_credit_increase_event.sql','0016_filtered_credit_state.sql']) await applyCreditMigration(db,name);
  await db.query("SELECT credit.append_diff('2026-08-21','甲银行','{\"notes\":\"第一次\"}','author')");
  const before=(await db.query('SELECT to_jsonb(d) AS data FROM credit.diff d ORDER BY id')).rows;
  assert.ok((await db.query('SELECT count(*)::int AS n FROM credit.diff_merge_archive')).rows[0].n>0);
  await applyCreditMigration(db,'0017_remove_diff_merge_archive.sql');
  assert.deepEqual((await db.query('SELECT to_jsonb(d) AS data FROM credit.diff d ORDER BY id')).rows,before);
  assert.equal((await db.query("SELECT to_regclass('credit.diff_merge_archive') AS name")).rows[0].name,null);
  await db.query("SELECT credit.append_diff('2026-08-21','甲银行','{\"notes\":\"最终\"}','another-author')");
  const updated=(await db.query('SELECT to_jsonb(d) AS data FROM credit.diff d')).rows[0].data;
  for (const field of ['id','created_at','created_by','total']) assert.equal(updated[field],before[0].data[field]);
  assert.equal(updated.notes,'最终');
  await db.exec('BEGIN');
  await assert.rejects(db.query("SELECT credit.append_diff('2026-08-21','甲银行','{\"expiry_date\":\"2025-01-01\"}','another-author')"),/expiry precedes/);
  await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT to_jsonb(d) AS data FROM credit.diff d')).rows[0].data,updated);
});
