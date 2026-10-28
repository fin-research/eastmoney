import {buildCreditReport} from '../src/lib/credit/build-report.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {creditDatabase,seedCredit,finishCreditMigrations} from './helpers/credit-database.mjs';
import {creditEffectiveStatus} from '../src/lib/credit/validity.ts';
import {loadCreditReport,saveCreditInstitution,persistCreditWorkbook} from '../src/lib/server/credit-repository.ts';

test('到期日覆盖状态，缺失日期保留底层审批状态，撤销哨兵优先',()=>{
  const row={status:'approved',effectiveDate:'2026-08-31',expiryDate:'2026-09-10',reportDate:'2026-09-10'};
  assert.equal(creditEffectiveStatus(row),'approved');
  assert.equal(creditEffectiveStatus({...row,reportDate:'2026-09-11'}),'applying');
  assert.equal(creditEffectiveStatus({...row,reportDate:'2026-08-30'}),'approved');
  for(const status of ['applying','revoked'])assert.equal(creditEffectiveStatus({...row,status,expiryDate:null}),status);
  assert.equal(creditEffectiveStatus({...row,expiryDate:'1970-01-01'}),'revoked');
  assert.equal(creditEffectiveStatus({...row,effectiveDate:null,expiryDate:null}),'approved');
});

test('跨日到期无需写入即可退出汇总，续作日期恢复有效并保留历史截面及到期事件',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{expiry_date:'2026-09-10'});
  const count=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  const before=await loadCreditReport(db,'2026-09-10'),after=await loadCreditReport(db,'2026-09-11');
  assert.equal(before.summary.totalLimit,10);assert.equal(before.summary.totalUsed,3);
  assert.equal(after.summary.approvedCount,0);assert.equal(after.summary.totalLimit,0);assert.equal(after.summary.totalUsed,0);
  assert.equal(after.institutions[0].status,'applying');assert.equal(after.institutions[0].effectiveStatus,'applying');
  assert.ok(after.calendarEvents.some(e=>e.date==='2026-09-10'&&e.kind==='expiry'));
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,count);
  const renewed=await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-12',institutionName:'甲银行',changes:{institution:{effectiveDate:'2026-09-12',expiryDate:'2027-09-11'}}},'auth0|test');
  assert.equal(buildCreditReport(renewed.data).institutions[0].effectiveStatus,'approved');assert.equal(buildCreditReport(renewed.data).summary.totalLimit,10);
  assert.equal((await loadCreditReport(db,'2026-09-11')).summary.totalLimit,0);
  assert.equal((await loadCreditReport(db,'2026-09-12')).weeklyNews.filter(e=>e.eventType==='renewal').length,1);
});

test('日期覆盖底层状态，起始日期不影响获批，无日期保留审批事实',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{effective_date:'2026-09-12',expiry_date:'2027-09-11'});
  await seedCredit(db,'2026-08-21','乙银行',{status:'applying',expiry_date:'2027-09-11'});
  await seedCredit(db,'2026-08-21','丙银行',{status:'applying',effective_date:null,expiry_date:null});
  await seedCredit(db,'2026-08-21','丁银行',{status:'approved',effective_date:null,expiry_date:null});
  assert.equal((await loadCreditReport(db,'2026-09-11')).summary.approvedCount,3);
  assert.equal((await loadCreditReport(db,'2026-09-12')).summary.approvedCount,3);
});

test('提前登记续期按最新到期日覆盖，不回退旧期限或按起始日排除',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-21','甲银行',{effective_date:'2025-09-21',expiry_date:'2026-09-21'});
  await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-04',institutionName:'甲银行',changes:{institution:{effectiveDate:'2026-09-21',expiryDate:'2027-09-21'}}},'auth0|test');
  for(const date of ['2026-09-11','2026-09-21'])assert.equal((await loadCreditReport(db,date)).summary.approvedCount,1);
  assert.equal((await loadCreditReport(db,'2026-09-11')).institutions[0].expiryDate,'2027-09-21');
  await saveCreditInstitution(db,{operation:'renewal',reportDate:'2026-09-12',institutionName:'甲银行',changes:{institution:{effectiveDate:'2027-10-01',expiryDate:'2028-10-01'}}},'auth0|test');
  assert.equal((await loadCreditReport(db,'2027-09-22')).summary.approvedCount,1);
  assert.equal((await loadCreditReport(db,'2027-10-01')).summary.approvedCount,1);
});

test('金额清空不能静默显示保存成功；明确零生效且可回溯，导入空白保留并警告',async t=>{
  const db=await creditDatabase(t);await seedCredit(db);
  const input={reportDate:'2026-08-22',institutionName:'甲银行',changes:{items:[{type:'bond_investment',limitAmount:null}]}};
  await assert.rejects(saveCreditInstitution(db,input,'auth0|test'),e=>e.status===400&&/请填0/.test(e.message));
  const source=(await loadCreditReport(db,'2026-08-21')).institutions[0];source.items[0].limitAmount=null;
  const result=await persistCreditWorkbook(db,{parsed:{reportDate:'2026-08-22',institutions:[source],warnings:[]}});
  assert.ok(result.warnings.some(w=>w.includes('额度原表空白，保留线上4亿元')));
  input.changes.items[0].limitAmount=0;
  await saveCreditInstitution(db,input,'auth0|test');
  assert.equal((await loadCreditReport(db,'2026-08-22')).institutions[0].items[0].limitAmount,0);
  assert.equal((await loadCreditReport(db,'2026-08-21')).institutions[0].items[0].limitAmount,4);
});

test('确认数据修复按真实业务日回填，邮储3.2仅在9月11日增加，迁移可回滚且重复执行幂等',async t=>{
  const db=await creditDatabase(t,false,false,false,true);
  for(const name of ['上海农商行（金市）','上海农商行（资管）','昆仑银行','邮储银行'])await db.query("INSERT INTO public.client(name,type) VALUES ($1,'银行')",[name]);
  const add=(date,name,patch)=>db.query('SELECT credit.append_diff($1,$2,$3::jsonb,NULL)',[date,name,JSON.stringify(patch)]);
  const base={institution_type:'银行',status:'approved',confidentiality_status:false,total:8,effective_date:'2025-08-31',expiry_date:'2026-08-31'};
  for(const name of ['上海农商行（金市）','上海农商行（资管）']){
    await add('2026-08-21',name,base);await add('2026-09-04',name,{status:'applying'});
  }
  await add('2026-08-21','昆仑银行',{...base,yield_certificate_limit:5,interbank_lending_limit:5,detail:'固定收益凭证、拆借、债券投资'});
  await add('2026-08-21','邮储银行',{...base,expiry_date:'2027-06-11',bond_investment_secondary_used:7.3});
  const sql=fs.readFileSync(new URL('../credit-migrations/0011_reconcile_confirmed_credit_changes.sql',import.meta.url),'utf8');
  const original=(await db.query('SELECT to_jsonb(d) data FROM credit.diff d ORDER BY id')).rows;
  await db.exec('BEGIN');await db.exec(sql);await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT to_jsonb(d) data FROM credit.diff d ORDER BY id')).rows,original);
  await db.exec('BEGIN');await db.exec(sql);await db.exec('COMMIT');
  const state=async(date,name)=>(await db.query('SELECT to_jsonb(s) data FROM credit.state_as_of($1) s WHERE institution_name=$2',[date,name])).rows[0].data;
  for(const name of ['上海农商行（金市）','上海农商行（资管）']){
    assert.equal((await state('2026-08-30',name)).effective_date,'2025-08-31');
    assert.equal((await state('2026-09-04',name)).status,'approved');
    assert.equal((await state('2026-08-31',name)).effective_date,'2026-08-31');
  }
  assert.equal(Number((await state('2026-08-21','昆仑银行')).yield_certificate_limit),0);
  assert.equal(Number((await state('2026-09-10','邮储银行')).bond_investment_secondary_used),7.3);
  assert.equal(Number((await state('2026-09-11','邮储银行')).bond_investment_secondary_used),10.5);
  const count=(await db.query('SELECT count(*) n FROM credit.diff')).rows[0].n;
  await db.exec('BEGIN');await db.exec(sql);await db.exec('COMMIT');
  assert.equal((await db.query('SELECT count(*) n FROM credit.diff')).rows[0].n,count);
  await assert.rejects(db.exec('UPDATE credit.diff SET total=0'),/append only/);
  await finishCreditMigrations(db,'0011_reconcile_confirmed_credit_changes.sql');
  const report=await loadCreditReport(db,'2026-09-11');
  assert.ok(report.calendarEvents.some(e=>e.institutionName==='邮储银行'&&e.date==='2026-09-11'&&e.label==='债券投资——二级买卖 · 增加3.2亿元'));

});
