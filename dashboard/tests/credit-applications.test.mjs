import assert from 'node:assert/strict';
import test from 'node:test';
import {applyCreditMigration,creditDatabase,seedCredit,finishCreditMigrations} from './helpers/credit-database.mjs';
import {loadCreditReport,saveCreditInstitution} from '../src/lib/server/credit-repository.ts';

test('维护拒绝总额增减和首次登记，分项额度及同精度总额仍可保存',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-21','甲银行',{total:10.123456,expiry_date:'2027-12-31'});
  await seedCredit(db,'2026-08-21','缺失银行',{total:null,expiry_date:'2027-12-31'});
  const save=(totalLimit,extra={})=>saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-30',institutionName:'甲银行',
    changes:{institution:{totalLimit,handler:'不能部分保存',verified:true},items:[{type:'bond_investment',limitAmount:8}]},...extra},'auth0|test');
  const snapshot=async()=>({entries:(await db.query('SELECT * FROM credit.entry ORDER BY institution_id,report_date,field_id')).rows,
    institutions:(await db.query('SELECT * FROM credit.institution ORDER BY id')).rows});
  const before=await snapshot();
  for(const total of [11,9,0,10.123457,10.123455,10.1234565]) {
    await assert.rejects(save(total),error=>error.status===400&&/维护不能变更授信总额/.test(error.message));
    assert.deepEqual(await snapshot(),before,'rejected writes must roll back metadata, entries and finalization');
  }
  for(const total of [0,1])await assert.rejects(save(total,{institutionName:'缺失银行'}),/维护不能变更授信总额/);
  await assert.rejects(save(null),/空白不修改已登记金额/);
  await save(null,{institutionName:'缺失银行'});
  await save(10.12345649);
  assert.equal(Number((await db.query("SELECT total FROM credit.entry_as_of('2026-09-30',ARRAY['甲银行'])")).rows[0].total),10.123456);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM credit.entry WHERE report_date='2026-09-30' AND field_id='total'")).rows[0].n,0);
  assert.equal((await db.query("SELECT bond_investment_limit::text AS amount FROM credit.entry_as_of('2026-09-30',ARRAY['甲银行'])")).rows[0].amount,'8.000000');
  await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-30',institutionName:'甲银行',changes:{items:[
    {type:'bond_investment',limitAmount:0},{type:'yield_certificate',limitAmount:3},
    {type:'interbank_lending',limitAmount:2},{type:'legal_overdraft',limitAmount:1},
  ]}},'auth0|test');
  const state=(await db.query("SELECT total::text,bond_investment_limit::text,yield_certificate_limit::text,interbank_lending_limit::text,legal_overdraft_limit::text FROM credit.entry_as_of('2026-09-30',ARRAY['甲银行'])")).rows[0];
  assert.deepEqual(state,{total:'10.123456',bond_investment_limit:'0.000000',yield_certificate_limit:'3.000000',interbank_lending_limit:'2.000000',legal_overdraft_limit:'1.000000'});
});

test('维护按业务日截面比较总额，同日已有申请也不能绕过',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-21','甲银行',{total:10,expiry_date:'2027-12-31'});
  await saveCreditInstitution(db,{operation:'increase',reportDate:'2026-09-30',institutionName:'甲银行',changes:{institution:{totalLimit:12}}});
  const maintenance=(reportDate,totalLimit)=>saveCreditInstitution(db,{reportDate,institutionName:'甲银行',changes:{institution:{totalLimit,notes:'维护备注'}}});
  await assert.rejects(maintenance('2026-09-30',13),/维护不能变更授信总额/);
  await assert.rejects(maintenance('2026-09-29',12),/维护不能变更授信总额/);
  await maintenance('2026-09-29',10);
  await maintenance('2026-09-30',12);
  assert.deepEqual((await db.query("SELECT DISTINCT event FROM credit.entry WHERE report_date='2026-09-30'")).rows,[{event:'increase'}]);
  assert.equal(Number((await db.query("SELECT total FROM credit.entry_as_of('2026-09-29')")).rows[0].total),10);
  // Formal renewal may reduce the total; maintenance must not be used for that change.
  await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-10-01',institutionName:'甲银行',changes:{institution:{totalLimit:11,expiryDate:'2028-12-31'}}});
  assert.equal(Number((await db.query("SELECT total FROM credit.entry_as_of('2026-10-01')")).rows[0].total),11);
});

test('历史同日续期兼扩额归为扩额并保留原事件归档',async t=>{
  const db=await creditDatabase(t,false,false,true);
  await seedCredit(db,'2026-08-21','浙江萧山农商行',{
    total:8,effective_date:'2025-09-22',expiry_date:'2026-09-25',
  });
  await db.query("SELECT credit.append_diff('2026-09-24','浙江萧山农商行',$1::jsonb,'auth0|test')",
    [JSON.stringify({effective_date:'2026-09-21',expiry_date:'2027-08-31'})]);
  await db.query("SELECT credit.append_diff('2026-09-24','浙江萧山农商行',$1::jsonb,'auth0|test')",
    [JSON.stringify({total:9})]);
  const state=async date=>(await db.query("SELECT total::float8,effective_date::text,expiry_date::text FROM credit.state_as_of($1::date) WHERE institution_name='浙江萧山农商行'",[date])).rows[0];
  const before=[await state('2026-09-21'),await state('2026-09-24')];
  await applyCreditMigration(db,'0013_explicit_credit_applications.sql');
  assert.equal((await db.query("SELECT type FROM credit.diff WHERE institution_name='浙江萧山农商行' AND effective_on='2026-09-24'")).rows[0].type,'renewal_increase');
  await applyCreditMigration(db,'0014_retire_credit_item_fields.sql');
  await applyCreditMigration(db,'0015_credit_increase_event.sql');
  await applyCreditMigration(db,'0016_filtered_credit_state.sql');
  assert.deepEqual([await state('2026-09-21'),await state('2026-09-24')],before);
  const rows=(await db.query("SELECT id,type,total::float8,expiry_date::text FROM credit.diff WHERE institution_name='浙江萧山农商行' AND effective_on='2026-09-24'")).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].type,'increase');
  assert.equal(rows[0].total,9);
  assert.equal((await db.query('SELECT count(*)::int n FROM credit.diff_merge_archive')).rows[0].n,3);
  assert.equal((await db.query("SELECT original_row->>'type' AS type FROM credit.diff_merge_archive WHERE changed_by='migration:0015_credit_increase_event'")).rows[0].type,'renewal_increase');
  await assert.rejects(db.query("SELECT credit.append_diff('2026-09-25','浙江萧山农商行','{\"total\":10}'::jsonb,'auth0|test','renewal_increase')"),/Invalid credit diff input/);
  await finishCreditMigrations(db,'0015_credit_increase_event.sql');
  const report=await loadCreditReport(db,'2026-09-24','2026-09');
  assert.deepEqual(report.weeklyNews.map(row=>row.eventType),['increase']);
  assert.equal(report.calendarEvents.some(row=>row.date==='2026-09-21'&&row.kind==='expiry'),false);
  assert.ok(report.calendarEvents.some(row=>row.date==='2026-09-24'&&row.label==='授信扩额 · 9亿元'));
});

test('申请按操作校验，同日续期和扩额形成一条可追溯事件',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-21','甲银行',{
    total:8,effective_date:'2025-09-22',expiry_date:'2026-09-25',
  });
  await assert.rejects(saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{expiryDate:'2026-09-25'}}},'auth0|test'),/晚于原到期日/);
  await assert.rejects(saveCreditInstitution(db,{operation:'increase',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{totalLimit:8}}},'auth0|test'),/高于原额度/);
  await assert.rejects(saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{status:'revoked'}}},'auth0|test'),/对应授信申请操作/);
  await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{status:'applying'}}},'auth0|test');
  assert.equal((await loadCreditReport(db,'2026-09-24')).institutions[0].status,'approved');
  await assert.rejects(saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{expiryDate:'2027-08-31',handler:'不属于续期'}}},'auth0|test'),/不属于本操作/);
  await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{effectiveDate:'2026-09-21',expiryDate:'2027-08-31'}}},'auth0|test');
  await saveCreditInstitution(db,{operation:'increase',reportDate:'2026-09-24',institutionName:'甲银行',
    changes:{institution:{totalLimit:9}}},'auth0|test');
  const rows=(await db.query("SELECT DISTINCT event AS type FROM credit.entry WHERE institution_id=(SELECT id FROM credit.institution WHERE name='甲银行') AND report_date='2026-09-24'")).rows;
  assert.deepEqual(rows.map(row=>row.type),['increase']);
  assert.equal((await db.query("SELECT to_regclass('credit.diff_merge_archive') AS name")).rows[0].name,null);
  const report=await loadCreditReport(db,'2026-09-24','2026-09');
  assert.deepEqual(report.weeklyNews.map(row=>row.eventType),['increase']);
  assert.equal(report.weeklySummary.expiredInstitutionCount,0);
  assert.equal(report.calendarEvents.some(row=>row.date==='2026-09-21'&&row.kind==='expiry'),false);
});

test('首个业务日的显式新增进入日历和周报，申请中转获批生成新增事件',async t=>{
  const db=await creditDatabase(t);
  await saveCreditInstitution(db,{operation:'new',reportDate:'2026-09-24',institutionName:'首家银行',
    changes:{institution:{institutionType:'城商行',status:'approved',confidentialityStatus:false,totalLimit:5,
      effectiveDate:'2026-09-24',expiryDate:'2027-09-24'}}},'auth0|test',true);
  const first=await loadCreditReport(db,'2026-09-24','2026-09');
  assert.deepEqual(first.weeklyNews.map(row=>row.eventType),['new']);
  assert.ok(first.calendarEvents.some(row=>row.kind==='new'&&row.institutionName==='首家银行'));
  await saveCreditInstitution(db,{operation:'new',reportDate:'2026-09-25',institutionName:'待批银行',
    changes:{institution:{institutionType:'城商行',status:'applying',confidentialityStatus:false,totalLimit:3}}},'auth0|test',true);
  assert.equal((await loadCreditReport(db,'2026-09-25')).weeklyNews.some(row=>row.institutionName==='待批银行'),false);
  await saveCreditInstitution(db,{operation:'maintenance',reportDate:'2026-09-26',institutionName:'待批银行',
    changes:{institution:{status:'approved'}}},'auth0|test');
  assert.ok((await loadCreditReport(db,'2026-09-26')).weeklyNews.some(row=>row.institutionName==='待批银行'&&row.eventType==='new'));
});
