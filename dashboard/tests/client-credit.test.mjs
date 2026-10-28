import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { installBondInvestors, applyCreditMigration } from './helpers/credit-database.mjs';
import { PGlite } from '@electric-sql/pglite';
import { loadCreditReport, persistCreditWorkbook, saveCreditInstitution } from '../src/lib/server/credit-repository.ts';
import { creditInstitutionUpdateSchema } from '../src/lib/credit/update.ts';
import { creditItemTypes } from '../src/lib/credit/types.ts';
import { importDebtWorkbook, readDebtImportIndex } from '../src/lib/server/financing/debt-importer.js';
import { clientFromDebtCounterparty } from '../src/lib/financing/debt-import-client.js';
import { listClients, saveClient } from '../src/lib/server/financing/clients.ts';
import { transformWorkbook } from '../scripts/financing/lib/debt-transform.mjs';

async function database(t, legacy = false, through = null) {
  const db = new PGlite();
  const query = db.query.bind(db);
  db.query = async (...args) => { const result = await query(...args); return {...result,rowCount: result.rows.length || result.affectedRows || 0}; };
  t.after(() => db.close());
  for (const name of ['0001_financing_postgres.sql','0007_detach_projects_from_debt.sql','0015_income_certificate_dates_and_names.sql','0028_client_master.sql','0031_bank_client_identity.sql']) {
    await db.exec(fs.readFileSync(new URL(`../financing-migrations/${name}`, import.meta.url),'utf8'));
  }
  await db.exec(`INSERT INTO public.client(name,fullname,type,subtype) VALUES
    ('招商银行','招商银行股份有限公司','银行','股份行'),('中银理财','中银理财有限责任公司','理财子',NULL),('乙银行',NULL,'银行','城商行');
    INSERT INTO public.client_alias(alias,match_kind,client_id,notes) VALUES
    ('^银行-申万宏源证券资产管理有限公司\\(代“申万宏源招行凭证一号单一资产管理计划','pattern',1,'实际投资人'),
    (public.normalize_client_name('银行-申万宏源证券资产管理有限公司（代“申万宏源招行凭证一号单一资产管理计划”）'),'exact',1,'实际投资人'),
    (public.normalize_client_name('银行-信银理财有限责任公司（代中银理财之乐赢稳健和信一年定开5期净值型人民币理财产品）'),'exact',2,'用户确认');`);
  await installBondInvestors(db);
  await db.exec('CREATE SCHEMA IF NOT EXISTS credit; CREATE TABLE credit.schema_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of fs.readdirSync(new URL('../credit-migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()) {
    if ((!legacy || name < '0005') && (!through || name <= through)) await applyCreditMigration(db,name);
  }
  return db;
}

async function institution(db, date='2026-09-04', name='合并授信') {
  const current=(await db.query("SELECT to_regclass('credit.diff') AS name")).rows[0].name;
  const entries=(await db.query("SELECT to_regclass('credit.entry') AS name")).rows[0].name;
  if (current||entries) {
    await db.query(`SELECT credit.${entries?'append_entry':'append_diff'}($1,$2,$3,$4)`,[date,name,JSON.stringify({institution_type:'银行',confidentiality_status:false,status:'approved',total:20,
      ...Object.fromEntries(creditItemTypes.filter(type=>type!=='other').map(type=>[type+'_limit',20])),other_used:2,bond_investment_used:0,legal_overdraft_used:0}),'auth0|test']);
  } else {
    await db.query(`INSERT INTO credit.institution(report_date,institution_name,institution_type,confidentiality_status,status,total_limit,total_used)
      VALUES ($1,$2,'银行',false,'approved',20,10)`,[date,name]);
    for (const type of creditItemTypes) await db.query(`INSERT INTO credit.item(report_date,institution_name,item_type,limit_amount,used_amount)
      VALUES ($1,$2,$3,20,$4)`,[date,name,type,type==='yield_certificate'?8:type==='other'?2:0]);
  }
}

test('customer matching keeps actual investors, supports prefixes, and never guesses an unknown plan manager',async t=>{
  const db=await database(t);
  for (const [raw,id] of [
    ['银行-招商银行股份有限公司',1],
    ['银行-申万宏源证券资产管理有限公司（代“申万宏源招行凭证一号单一资产管理计划”）',1],
    ['银行-信银理财有限责任公司（代中银理财之乐赢稳健和信一年定开5期净值型人民币理财产品）',2],
    ['银行-申万宏源证券资产管理有限公司（代“未知投资人计划”）',null]
  ]) assert.equal((await db.query('SELECT public.resolve_client($1) AS id',[raw])).rows[0].id,id);
  await db.query(`INSERT INTO financing.income_certificate(debt_type,subtype,name,counterparty,amount) VALUES ('收益凭证','固定收益凭证','测试凭证','银行-招商银行股份有限公司',1)`);
  assert.equal((await db.query('SELECT client_id FROM financing.debt')).rows[0].client_id,1);
  await assert.rejects(db.query(`UPDATE financing.income_certificate SET client_id=9999`),/foreign key/);
  await db.query('UPDATE financing.income_certificate SET client_id=2');
  await db.query('UPDATE financing.income_certificate SET amount=2');
  assert.equal((await db.query('SELECT client_id FROM financing.debt')).rows[0].client_id,2);
  await assert.rejects(db.query('DELETE FROM public.client WHERE id=2'),/foreign key/);
});

test('static combined credit sums clients once and excludes matured, future and closed debt',async t=>{
  const db=await database(t);
  await institution(db);
  await db.exec(`INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes) SELECT i.id,i.name,c.id,'明确合并' FROM credit.institution i CROSS JOIN public.client c WHERE i.name='合并授信' AND c.id IN(1,2)`);
  await db.exec(`INSERT INTO financing.income_certificate(debt_type,subtype,name,client_id,amount,issue_date,activated_at,maturity_date) VALUES
    ('收益凭证','固定收益凭证','存续甲',1,100000000,'2026-08-01','2026-08-01','2027-08-01'),
    ('收益凭证','固定收益凭证','存续乙',2,200000000,'2026-08-01','2026-08-01','2027-08-01'),
    ('收益凭证','固定收益凭证','当天到期',1,900000000,'2026-08-01','2026-08-01','2026-09-04'),
    ('收益凭证','固定收益凭证','未来',1,900000000,'2026-09-05','2026-09-05','2027-08-01');
    INSERT INTO financing.debt(debt_type,name,client_id,amount,issue_date,activated_at,maturity_date,closed_at) VALUES
    ('同业拆借','存续拆借',1,400000000,'2026-09-01','2026-09-01','2026-09-10',NULL),
    ('同业拆借','已关闭',1,900000000,'2026-09-01','2026-09-01','2026-09-10','2026-09-03');`);
  const report=await loadCreditReport(db,'2026-09-04');
  const row=report.institutions[0];
  assert.equal(row.totalUsed,9);
  assert.equal(row.importedTotalUsed,undefined);
  assert.equal(row.clients.length,2);
  assert.equal(row.items.find(i=>i.type==='yield_certificate').usedAmount,3);
  assert.equal(row.items.find(i=>i.type==='yield_certificate').importedUsedAmount,undefined);
  assert.ok((await db.query("SELECT to_regclass('credit.institution') current")).rows[0].current);
  await institution(db,'2026-09-04','重复授信');
  await assert.rejects(db.query(`INSERT INTO credit.institution_client(institution_id,institution_name,client_id,notes) SELECT id,name,1,'重复测试' FROM credit.institution WHERE name='重复授信'`),/unique/);
  const unknown=(await loadCreditReport(db,'2026-09-04')).institutions.find(i=>i.institutionName==='重复授信');
  assert.equal(unknown.totalUsed,null);
  assert.equal(unknown.availableAmount,null);
  // Other manually maintained usage changes the total, financing usage is read-only.
  await saveCreditInstitution(db,{reportDate:'2026-09-04',institutionName:'合并授信',changes:{items:[{type:'other',usedAmount:5}]}});
  assert.equal((await loadCreditReport(db,'2026-09-04')).institutions[0].totalUsed,12);
});

test('credit import keeps static manual mappings and automatically links clear new customers',async t=>{
  const db=await database(t);
  await institution(db,'2026-09-04','乙银行');
  assert.equal((await db.query('SELECT client_id FROM credit.institution_client')).rows[0].client_id,3);
  await db.query("UPDATE credit.institution_client SET client_id=2,notes='人工确认主体'");
  const original=(await loadCreditReport(db,'2026-09-04')).institutions[0];
  await persistCreditWorkbook(db,{parsed:{reportDate:'2026-09-04',institutions:[original],approvedCount:1,totalLimit:20,totalUsed:10,totalAvailable:10,weeklyApprovedCount:1,weeklyTotalLimit:20,weeklyTotalUsed:10,weeklyTotalAvailable:10}});
  assert.equal((await db.query('SELECT client_id FROM credit.institution_client')).rows[0].client_id,2);
  assert.equal((await loadCreditReport(db,'2026-09-04')).institutions[0].items.find(i=>i.type==='yield_certificate').usedAmount,0);
});

test('API rejects edits to derived total and financing usage but permits other components',()=>{
  const input=changes=>({operation:'maintenance',reportDate:'2026-09-04',institutionName:'甲',changes});
  for(const type of ['yield_certificate','interbank_lending']) assert.equal(creditInstitutionUpdateSchema.safeParse(input({items:[{type,usedAmount:4}]})).success,false);
  assert.equal(creditInstitutionUpdateSchema.safeParse(input({items:[{type:'bond_investment',secondaryUsedAmount:-4}]})).success,true);
  assert.equal(creditInstitutionUpdateSchema.safeParse(input({institution:{totalUsed:5}})).success,false);
  assert.equal(creditInstitutionUpdateSchema.safeParse(input({items:[{type:'bond_investment',usedAmount:4}]})).success,false);
  assert.equal(creditInstitutionUpdateSchema.safeParse(input({items:[{type:'other',limitAmount:4}]})).success,false);
  for(const type of ['yield_certificate','legal_overdraft','interbank_lending'])
    assert.equal(creditInstitutionUpdateSchema.safeParse(input({items:[{type,details:'不再记录'}]})).success,false);
});

test('retired credit fields are archived before schema removal',async t=>{
  const db=await database(t,false,'0013_explicit_credit_applications.sql');
  await db.query('SELECT credit.append_diff($1,$2,$3::jsonb,$4)', ['2026-09-04','历史字段',JSON.stringify({
    institution_type:'银行',status:'approved',confidentiality_status:false,
    other_limit:5,yield_certificate_detail:'旧收益说明',legal_overdraft_detail:'旧法透说明',
  }),'auth0|test']);
  await applyCreditMigration(db,'0014_retire_credit_item_fields.sql');
  const archived=(await db.query('SELECT archived_values FROM credit.retired_diff_fields')).rows[0].archived_values;
  assert.equal(archived.other_limit,5);
  assert.equal(archived.yield_certificate_detail,'旧收益说明');
  assert.equal(archived.legal_overdraft_detail,'旧法透说明');
  assert.equal((await db.query("SELECT count(*) AS count FROM information_schema.columns WHERE table_schema='credit' AND table_name='diff' AND column_name IN ('other_limit','yield_certificate_detail','legal_overdraft_detail','interbank_lending_detail')")).rows[0].count,0);
  await db.query('SELECT credit.append_diff($1,$2,$3::jsonb,$4)', ['2026-09-05','历史字段',JSON.stringify({other_used:2}),'auth0|test']);
  await assert.rejects(db.query('SELECT credit.append_diff($1,$2,$3::jsonb,$4)', ['2026-09-05','历史字段',JSON.stringify({other_limit:2}),'auth0|test']),/Unknown credit diff field/);
});

test('incremental import preserves old principal, dates, client override, flows and balances, including repeated imports',async t=>{
  const db=await database(t);
  const payload={snapshot:{asOfDate:'2026-09-04',totalYi:1},debts:[{
    sourceKey:'one',table:'debt',debtType:'同业拆借',subtype:null,name:'甲拆借',counterparty:'招商银行',amount:100000000,interestPayable:0,
    annualRate:0.02,issueDate:'2026-09-01',maturityDate:'2026-09-10',activatedAt:'2026-09-01',settledAt:null,closedAt:null,extension:{}
  }],cashflows:[{sourceKey:'one',cashflowType:'principal',dueDate:'2026-09-10',amount:100000000,sourceSequence:1}],balances:[{asOfDate:'2026-09-04',debtType:'同业拆借',subtype:'',amount:100000000}]};
  const first=await importDebtWorkbook(db,payload);
  assert.equal(first.insertedDebtCount,1);
  await db.exec('UPDATE financing.debt SET client_id=2');
  const prior=(await db.query('SELECT to_jsonb(d) row FROM financing.debt d')).rows[0].row;
  payload.debts[0].amount=200000000;payload.debts[0].maturityDate='2026-09-11';payload.debts[0].settledAt='2026-09-04';
  payload.cashflows[0].amount=200000000;payload.balances[0].amount=200000000;payload.snapshot.totalYi=2;
  const repeat=await importDebtWorkbook(db,payload);
  assert.equal(repeat.insertedDebtCount,0);assert.equal(repeat.skippedDebtCount,1);assert.equal(repeat.updatedDebtCount,0);
  assert.equal(repeat.insertedCashflowCount,0);assert.equal(repeat.warnings.length,1);
  assert.deepEqual((await db.query('SELECT to_jsonb(d) row FROM financing.debt d')).rows[0].row,prior);
  assert.equal(Number((await db.query('SELECT amount FROM financing.cashflow')).rows[0].amount),100000000);
  assert.equal(Number((await db.query('SELECT amount FROM financing.balance_snapshot')).rows[0].amount),100000000);
  payload.debts.push({...payload.debts[0],sourceKey:'two',name:'新拆借',issueDate:'2026-09-04',activatedAt:'2026-09-04',settledAt:null});
  const increment=await importDebtWorkbook(db,payload);
  assert.equal(increment.insertedDebtCount,1);
  assert.equal((await importDebtWorkbook(db,payload)).insertedDebtCount,0);
  payload.snapshot.totalYi=99;
  await assert.rejects(importDebtWorkbook(db,payload),/余额核对失败/);
  assert.equal((await db.query('SELECT count(*) n FROM financing.debt')).rows[0].n,2);
});

test('note cleanup removes only empty note records and parsing never recreates them',async t=>{
  const db=await database(t);
  await db.exec(`INSERT INTO financing.debt(debt_type,name,counterparty,amount) VALUES
    ('集团借款','备注','截至目前集团共发行3次可转债：',0),('集团借款','正常客户','集团公司',0)`);
  await db.exec(fs.readFileSync(new URL('../financing-migrations/0029_remove_group_loan_notes.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('SELECT name FROM financing.debt')).rows.map(r=>r.name),['正常客户']);
  const parsed={debts:[[1,'note','集团借款',null,null,null,null,null,'截至目前集团共发行3次可转债：',0,0]],cashflows:[],balances:[],records:[],recordGroups:[],fields:[],definitions:[],cells:[],snapshot:{asOfDate:'2026-09-04',totalYi:0}};
  assert.equal(transformWorkbook(parsed).debts.length,0);
});

test('entry changes preserve component sums, typed values and controlled historical corrections', async t => {
  const db=await database(t);await institution(db,'2026-08-21','乙银行');
  const total=async date=>(await loadCreditReport(db,date)).institutions[0].totalUsed;
  assert.equal(await total('2026-08-21'),2);
  await assert.rejects(db.query("UPDATE credit.entry SET v_num=99 WHERE field_id='other_used'"),/append only/);
  await assert.rejects(db.query('DELETE FROM credit.entry'),/cannot be deleted/);
  await saveCreditInstitution(db,{reportDate:'2026-08-22',institutionName:'乙银行',changes:{items:[{type:'other',usedAmount:0.0245}]}},'auth0|test');
  assert.equal(await total('2026-08-22'),0.0245);assert.equal(await total('2026-08-21'),2);
  await db.exec("BEGIN; SET LOCAL credit.correct_history='on'; UPDATE credit.entry SET v_num=0.5 WHERE report_date='2026-08-21' AND field_id='other_used'; COMMIT");
  assert.equal(await total('2026-08-21'),0.5);assert.equal(await total('2026-08-22'),0.0245);
  assert.ok((await db.query("SELECT updated_at FROM credit.entry WHERE field_id='other_used' ORDER BY report_date LIMIT 1")).rows[0].updated_at);
  assert.equal((await db.query('SELECT count(*) n FROM credit.institution_client')).rows[0].n,1);
});

test('bank proprietary and asset clients own both financing types independently without item flags', async t => {
  const db = await database(t);
  await db.query("INSERT INTO public.client(name,type,subtype) VALUES ('乙银行资管','理财子','银行资管')");
  for (const name of ['乙银行（金市）', '乙银行（资管）']) await institution(db, '2026-09-04', name);
  await db.query(`INSERT INTO financing.debt(debt_type,name,counterparty,amount,activated_at,maturity_date) VALUES
    ('收益凭证','银行凭证','乙银行',100000000,'2026-08-01','2027-08-01'),
    ('同业拆借','银行拆借','乙银行',200000000,'2026-08-01','2027-08-01'),
    ('收益凭证','资管凭证','乙银行（资管）',300000000,'2026-08-01','2027-08-01'),
    ('同业拆借','资管拆借','乙银行资管',400000000,'2026-08-01','2027-08-01')`);
  const report = await loadCreditReport(db,'2026-09-04');
  const usage = name => report.institutions.find(i=>i.institutionName===name).items.filter(i=>i.usageSource==='financing').map(i=>i.usedAmount);
  assert.deepEqual(usage('乙银行（金市）'), [1,2]);
  assert.deepEqual(usage('乙银行（资管）'), [3,4]);
  assert.equal(report.summary.totalUsed, 14); // 10 financing + 2 other per subject.
  assert.equal((await db.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema='credit' AND table_name='institution_client' AND column_name IN ('yield_certificate','interbank_lending')")).rows[0].n,0);
});

test('confirmed 2021 group-loan typo is normalized before incremental identity matching', async t => {
  const db = await database(t);
  await db.query("INSERT INTO public.client(name,type) VALUES ('集团公司','其它')");
  const raw={debts:[[1,'group','集团借款',null,null,null,null,null,'东方财富证券股份有限公司',500000000,500000000,'CNY',null,'2021-09-06','2021-09-14','matured']],cashflows:[],balances:[],records:[],recordGroups:[],fields:[],definitions:[],cells:[],snapshot:{asOfDate:'2021-09-14',totalYi:0}};
  const payload=transformWorkbook(raw);
  assert.equal(payload.debts[0].counterparty,'集团公司');
  assert.equal(payload.debts[0].name,'集团借款·集团公司·2021-09-06');
  await db.query(`INSERT INTO financing.debt(id,debt_type,name,counterparty,amount,issue_date,maturity_date)
    VALUES (9445,'集团借款','集团借款·东方财富证券股份有限公司·2021-09-06','东方财富证券股份有限公司',500000000,'2021-09-06','2021-09-14')`);
  await db.exec(fs.readFileSync(new URL('../financing-migrations/0030_correct_group_loan_counterparty.sql',import.meta.url),'utf8'));
  const result=await importDebtWorkbook(db,payload);
  assert.equal(result.insertedDebtCount,0);
  assert.equal(result.skippedDebtCount,1);
  assert.equal((await db.query('SELECT counterparty FROM financing.debt WHERE id=9445')).rows[0].counterparty,'集团公司');
});

test('nonempty migration converts all NDA states, consolidates dates and applies the confirmed historical amounts', async t => {
  const db=await database(t,true);
  await db.query(`INSERT INTO credit.client_mapping(institution_name,client_id,notes) VALUES ('浦发银行',1,'测试'),('北京农商行',2,'测试'),('昆山农商行',3,'测试')`);
  await db.query(`INSERT INTO credit.institution(report_date,source_row,institution_name,institution_type,confidentiality_status,status,included_in_weekly_report,total_limit,total_used) VALUES
    ('2026-08-28',4,'浦发银行','股份行','signed','approved',false,100,87.5),
    ('2026-08-21',5,'北京农商行','农商行','not_signed','approved',true,20,9.0245),
    ('2026-08-21',6,'昆山农商行','农商行','unknown','approved',false,10,0),
    ('2026-08-28',5,'北京农商行','农商行','not_signed','approved',true,20,9)`);
  await db.query(`INSERT INTO credit.item(report_date,institution_name,item_type,used_amount)
    SELECT i.report_date,i.institution_name,t::credit.item_type,
      CASE WHEN institution_name='浦发银行' THEN CASE t WHEN 'yield_certificate' THEN 65 WHEN 'bond_investment' THEN 7.5 WHEN 'interbank_lending' THEN 5 WHEN 'other' THEN 10 ELSE 0 END
        WHEN institution_name='北京农商行' THEN CASE t WHEN 'yield_certificate' THEN 5 WHEN 'bond_investment' THEN 4 ELSE 0 END
        ELSE CASE t WHEN 'bond_investment' THEN 0.5 ELSE 0 END END
    FROM credit.institution i CROSS JOIN unnest($1::text[]) t`,[creditItemTypes]);
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0005_static_clients_and_usage_totals.sql',import.meta.url),'utf8'));
  const rows=(await db.query("SELECT institution_name,confidentiality_status,total_used::float8 FROM credit.institution WHERE (report_date='2026-08-21') OR institution_name='浦发银行' ORDER BY institution_name")).rows;
  assert.deepEqual(rows.map(r=>[r.institution_name,r.confidentiality_status,r.total_used]),[['北京农商行',false,9.0245],['昆山农商行',false,0.5],['浦发银行',true,67.5]]);
  assert.equal((await db.query('SELECT count(*) n FROM credit.institution_client')).rows[0].n,3);
  assert.equal((await db.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema='credit' AND (column_name IN ('source_row','included_in_weekly_report') OR (table_name='institution_client' AND column_name='report_date'))")).rows[0].n,0);
  assert.equal((await db.query("SELECT to_regclass('credit.client_mapping') old_table")).rows[0].old_table,null);
});


test('explicit bank asset suffixes resolve to separate wealth clients, while unmarked banks and verified investors stay proprietary', async t => {
  const db=await database(t);
  const assetId=(await db.query("INSERT INTO public.client(name,type,subtype) VALUES ('招商银行资管','理财子','银行资管') RETURNING id")).rows[0].id;
  for (const raw of ['招商银行（资管）','招商银行资管','招商银行资产管理部','银行-招商银行股份有限公司(资产管理)']) {
    assert.equal((await db.query('SELECT public.resolve_client($1) id',[raw])).rows[0].id,assetId);
  }
  for (const raw of ['招商银行','银行-招商银行股份有限公司','招商银行（金市）','招商银行自营','银行-申万宏源证券资产管理有限公司（代“申万宏源招行凭证一号单一资产管理计划”）']) {
    assert.equal((await db.query('SELECT public.resolve_client($1) id',[raw])).rows[0].id,1);
  }
  // An explicit asset department must never silently fall back to its bank when missing.
  assert.equal((await db.query("SELECT public.resolve_client('乙银行（资管）') id")).rows[0].id,null);
  assert.equal((await db.query("SELECT public.resolve_client('未知银行（资管）') id")).rows[0].id,null);
});

test('bank asset migration separates existing identities and aliases without changing business amounts', async t => {
  const db=await database(t,true);
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0005_static_clients_and_usage_totals.sql',import.meta.url),'utf8'));
  await db.query(`INSERT INTO credit.institution_client(institution_name,client_id,yield_certificate,interbank_lending,notes) VALUES
    ('乙银行（金市）',3,false,true,'旧品种分配'),('乙银行（资管）',3,true,false,'旧品种分配')`);
  await db.query("INSERT INTO public.client_alias(alias,client_id,notes) VALUES ('乙银行(资管)',3,'旧银行别名')");
  for(const name of ['乙银行（金市）','乙银行（资管）']) await institution(db,'2026-09-04',name);
  await db.query(`INSERT INTO financing.debt(debt_type,name,counterparty,client_id,amount,activated_at,maturity_date) VALUES
    ('收益凭证','未标注资管','乙银行',3,100000000,'2026-08-01','2027-08-01'),
    ('收益凭证','明确资管','银行-乙银行（资管）',3,200000000,'2026-08-01','2027-08-01')`);
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0006_bank_asset_management_clients.sql',import.meta.url),'utf8'));
  const asset=(await db.query("SELECT * FROM public.client WHERE name='乙银行资管'")).rows[0];
  assert.equal(asset.type,'理财子');assert.equal(asset.fullname,null);
  assert.deepEqual((await db.query("SELECT name,client_id,amount::float8 amount FROM financing.debt ORDER BY name")).rows,
    [{name:'明确资管',client_id:asset.id,amount:200000000},{name:'未标注资管',client_id:3,amount:100000000}]);
  assert.equal((await db.query("SELECT client_id FROM public.client_alias WHERE alias='乙银行(资管)'")).rows[0].client_id,asset.id);
  await assert.rejects(db.query("INSERT INTO credit.institution_client(institution_name,client_id,notes) VALUES ('重复主体',3,'重复')"),/unique/);
});

test('generic client matching covers prefixes, legal suffixes, bank variants and geography without alias rows', async t => {
  const db=await database(t);
  await db.query(`INSERT INTO public.client(name,fullname,type) VALUES
    ('浙江萧山农商行','浙江萧山农村商业银行股份有限公司','银行'),
    ('衡阳农商行','湖南衡阳农村商业银行股份有限公司','银行'),
    ('长春农商行','长春农村商业银行股份有限公司','银行'),
    ('中国进出口银行','中国进出口银行','银行'),
    ('上海农商行','上海农村商业银行股份有限公司','银行'),
    ('江西百胜智能科技','江西百胜智能科技股份有限公司','营业部客户')`);
  for(const [raw,name] of [
    ['银行-萧山农商银行','浙江萧山农商行'],['浙江省萧山农村商业银行','浙江萧山农商行'],
    ['湖南衡阳农商行','衡阳农商行'],['衡阳农商银行','衡阳农商行'],
    ['长春农商行(被吉林农商行吸收合并)','长春农商行'],['进出口行','中国进出口银行'],
    ['营业部大客户江西百胜智能科技股份有限公司','江西百胜智能科技']]){
    assert.equal((await db.query('SELECT c.name FROM public.client c WHERE c.id=public.resolve_client($1)',[raw])).rows[0]?.name,name);
  }
  await db.query(`INSERT INTO public.client(name,fullname,type) VALUES
    ('浙江永安农商行','浙江永安农村商业银行股份有限公司','银行'),
    ('福建永安农商行','福建永安农村商业银行股份有限公司','银行')`);
  for(const raw of ['永安农商银行','湖南永安农商银行','农商银行','银行']) assert.equal((await db.query('SELECT public.resolve_client($1) id',[raw])).rows[0].id,null);
  assert.equal((await db.query("SELECT c.name FROM public.client c WHERE c.id=public.resolve_client('福建省永安农商银行')")).rows[0].name,'福建永安农商行');
});

test('wealth product matching is generic but conflicting owners still require an exact exception', async t => {
  const db=await database(t);
  for(const name of ['信银理财','光大理财','宁银理财','建信理财']) {
    await db.query("INSERT INTO public.client(name,type) VALUES ($1,'理财子')",[name]);
    for(const raw of [`银行-${name}有限责任公司（代“${name}全新99号理财产品”）`,`${name}有限责任公司代${name}全新产品`]) {
      assert.equal((await db.query('SELECT c.name FROM public.client c WHERE c.id=public.resolve_client($1)',[raw])).rows[0].name,name);
    }
  }
  const cross='银行-信银理财有限责任公司（代中银理财之乐赢稳健和信一年定开5期净值型人民币理财产品）';
  assert.equal((await db.query('SELECT public.resolve_client_by_rules($1) id',[cross])).rows[0].id,null);
  assert.equal((await db.query('SELECT public.resolve_client($1) id',[cross])).rows[0].id,2);
  assert.equal((await db.query("SELECT public.resolve_client('银行-信银理财有限责任公司代中银理财未经确认的新产品') id")).rows[0].id,null);
});

test('known product names resolve through account-holder text without guessing unknown products', async t => {
  const db=await database(t);
  for(const name of ['国泰君安私客臻享18号单一资产管理计划','外贸信托-稳进慧盈A款12期集合资金信托计划','上汽颀臻颀瑞8号私募证券投资基金']) await db.query("INSERT INTO public.client(name,type) VALUES ($1,'营业部客户')",[name]);
  for(const [raw,name] of [
    ['机构投资者-上海国泰君安证券资产管理有限公司代国泰君安私客臻享18号单一资产管理计划','国泰君安私客臻享18号单一资产管理计划'],
    ['营业部大客户-中国对外经济贸易信托有限公司(代表“外贸信托-稳进慧盈A款12期集合资金信托计划”)','外贸信托-稳进慧盈A款12期集合资金信托计划'],
    ['营业部大客户-上汽颀臻(上海)资产管理有限公司上汽颀臻颀瑞8号私募证券投资基金','上汽颀臻颀瑞8号私募证券投资基金']]) assert.equal((await db.query('SELECT c.name FROM public.client c WHERE c.id=public.resolve_client($1)',[raw])).rows[0].name,name);
  assert.equal((await db.query("SELECT public.resolve_client('机构投资者-上海国泰君安证券资产管理有限公司代未知999号单一资产管理计划') id")).rows[0].id,null);
});

test('alias migration removes redundant exact and regex rules, keeps ownership exceptions, and drops obsolete columns', async t => {
  const db=await database(t,true);
  for(const name of ['0005_static_clients_and_usage_totals.sql','0006_bank_asset_management_clients.sql']) await applyCreditMigration(db,name);
  await db.query(`INSERT INTO public.client_alias(alias,match_kind,client_id,notes) VALUES
    ('招商银行','exact',1,'重复名称'),('银行-招商银行股份有限公司','exact',1,'重复前缀'),
    ('^银行-中银理财.*','pattern',2,'旧正则'),('特殊主体','exact',3,'保留特殊')`);
  await institution(db,'2026-09-04','招商银行');
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0007_simplify_client_aliases.sql',import.meta.url),'utf8'));
  const aliases=(await db.query('SELECT alias FROM public.client_alias ORDER BY alias')).rows.map(r=>r.alias);
  assert.equal(aliases.length,3);assert.ok(aliases.includes('特殊主体'));assert.ok(aliases.every(a=>!a.startsWith('^')));
  assert.deepEqual((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='client_alias' ORDER BY column_name")).rows.map(r=>r.column_name),['alias','client_id']);
  assert.equal((await db.query("SELECT public.resolve_client('银行-招商银行股份有限公司') id")).rows[0].id,1);
  assert.equal((await db.query("SELECT public.resolve_client('银行-特殊主体') id")).rows[0].id,3);
});


test('new branch customers are created and linked in the import transaction',async t=>{
 const db=await database(t);
 const names=['营业部大客户-厦门东昂科技股份有限公司','营业部大客户-广电运通集团股份有限公司'];
 const payload={snapshot:{asOfDate:'2026-09-04',totalYi:1},debts:names.map((counterparty,i)=>({
  sourceKey:`branch-${i}`,table:'debt',debtType:'同业拆借',name:`新增-${i}`,counterparty,amount:50000000,interestPayable:0,extension:{}})),
 cashflows:[],balances:[{asOfDate:'2026-09-04',debtType:'同业拆借',subtype:'',amount:100000000}]};
 const result=await importDebtWorkbook(db,payload);
 assert.equal(result.insertedDebtCount,2);assert.equal(result.createdClientCount,2);
 assert.deepEqual(result.unlinkedClientNames,[]);
 const linked=(await db.query(`SELECT c.name,c.type FROM financing.debt d JOIN public.client c ON c.id=d.client_id ORDER BY c.name`)).rows;
 assert.deepEqual(linked,[
  {name:'厦门东昂科技股份有限公司',type:'营业部客户'},
  {name:'广电运通集团股份有限公司',type:'营业部客户'}
 ]);
 assert.equal((await importDebtWorkbook(db,payload)).createdClientCount,0);
 assert.equal((await db.query('SELECT count(*) n FROM public.client WHERE type=$1',['营业部客户'])).rows[0].n,2);
 assert.deepEqual(clientFromDebtCounterparty('营业部大客户-某某公司（代表“某某1号资金信托计划”）'),
  {name:'某某1号资金信托计划',fullname:null,type:'营业部客户',subtype:null});
 assert.equal(clientFromDebtCounterparty('营业部大客户新客户有限公司').name,'新客户有限公司');
});

test('failed business validation rolls back automatically created customers',async t=>{
 const db=await database(t);
 const payload={snapshot:{asOfDate:'2026-09-04',totalYi:2},debts:[{
  sourceKey:'new',table:'debt',debtType:'同业拆借',name:'测试',counterparty:'营业部大客户-新客户有限公司',amount:100000000,interestPayable:0,extension:{}
 }],cashflows:[],balances:[{asOfDate:'2026-09-04',debtType:'同业拆借',subtype:'',amount:100000000}]};
 await assert.rejects(importDebtWorkbook(db,payload),/余额核对失败/);
 assert.equal((await db.query("SELECT count(*) n FROM public.client WHERE name='新客户有限公司'")).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*) n FROM financing.debt')).rows[0].n,0);
});

test('ambiguous customers leave one new debt unlinked without rejecting the import',async t=>{
 const db=await database(t);
 await db.exec("INSERT INTO public.client(name,type) VALUES('测试银行','银行'),('测试银行股份有限公司','银行')");
 const payload={snapshot:{asOfDate:'2026-09-04',totalYi:1},debts:[{
  sourceKey:'ambiguous',table:'debt',debtType:'同业拆借',name:'测试',counterparty:'银行-测试银行',amount:100000000,interestPayable:0,extension:{}
 }],cashflows:[],balances:[{asOfDate:'2026-09-04',debtType:'同业拆借',subtype:'',amount:100000000}]};
 const result=await importDebtWorkbook(db,payload);
 assert.equal(result.insertedDebtCount,1);assert.equal(result.createdClientCount,0);
 assert.deepEqual(result.unlinkedClientNames,['银行-测试银行']);
 assert.match(result.warnings.join(' '),/未能唯一关联/);
 assert.equal((await db.query("SELECT client_id FROM financing.debt WHERE name='测试'")).rows[0].client_id,null);
});

test('downloaded index is read only, stale versions fail, and a retry is idempotent',async t=>{
 const db=await database(t);
 const payload={snapshot:{asOfDate:'2026-09-04',totalYi:1},debts:[{sourceKey:'a',table:'debt',debtType:'同业拆借',name:'测试',counterparty:'招商银行',amount:100000000,interestPayable:0,extension:{}}],cashflows:[],balances:[{asOfDate:'2026-09-04',debtType:'同业拆借',subtype:'',amount:100000000}]};
 const index=await readDebtImportIndex(db);assert.equal(index.debts.length,0);
 assert.equal((await db.query('SELECT count(*) n FROM financing.debt')).rows[0].n,0);
 const result=await importDebtWorkbook(db,payload,{expectedVersion:index.version});assert.equal(result.insertedDebtCount,1);
 await assert.rejects(importDebtWorkbook(db,payload,{expectedVersion:index.version}),/台账已发生变化/);
 const again=await readDebtImportIndex(db);assert.equal(again.debts.length,1);
 const repeat=await importDebtWorkbook(db,{...payload,balances:[],snapshotBalances:payload.balances},{expectedVersion:again.version});assert.equal(repeat.insertedDebtCount,0);
});

test('Tianjin Binhai alias resolves both new imports and previously unlinked records',async t=>{
 const db=await database(t);
 const client=(await db.query("SELECT id FROM public.client WHERE name='天津滨海农商行'")).rows[0];
 assert.equal((await db.query("SELECT public.resolve_client('天津滨海农村商行') AS id")).rows[0].id,client.id);
 await db.exec("DELETE FROM public.client_alias WHERE alias=public.client_match_key('天津滨海农村商行'); INSERT INTO financing.debt(debt_type,name,counterparty,amount) VALUES('同业拆借','旧记录','天津滨海农村商行',1)");
 await db.exec(fs.readFileSync(new URL('../credit-migrations/0012_tianjin_binhai_client_alias.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('SELECT client_id FROM financing.debt')).rows[0].client_id,client.id);
});

test('client maintenance supports search, aliases, conflicts, optimistic concurrency and preservation of existing identity',async t=>{
 const db=await database(t);
 const facade={transaction:fn=>db.transaction(tx=>fn(tx))};
 const created=await saveClient(facade,null,{name:'测试客户',fullname:null,type:'其它',subtype:null,aliases:['测试客户别称']});
 const listed=await listClients(db,'测试客户别称');assert.equal(listed.total,1);assert.equal(listed.rows[0].id,created.id);
 assert.equal(String((await db.query("SELECT public.resolve_client('测试客户别称') id")).rows[0].id),created.id);
 await assert.rejects(saveClient(facade,created.id,{name:'新简称',fullname:null,type:'其它',subtype:null,aliases:[],version:'stale'}),/客户已被修改/);
 await assert.rejects(saveClient(facade,created.id,{name:'新简称',fullname:null,type:'其它',subtype:null,aliases:['招商银行'],version:created.version}),/别名已关联其他客户/);
 const saved=await saveClient(facade,created.id,{name:'新简称',fullname:null,type:'其它',subtype:null,aliases:['测试客户别称'],version:created.version});
 assert.ok(saved.aliases.includes('测试客户'));assert.equal(saved.name,'新简称');
 assert.equal(String((await db.query("SELECT public.resolve_client('测试客户') id")).rows[0].id),created.id);
});
