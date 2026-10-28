import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { creditDatabase, seedCredit, finishCreditMigrations } from './helpers/credit-database.mjs';
import { loadCreditData, loadCreditReport, persistCreditWorkbook, saveCreditInstitution } from '../src/lib/server/credit-repository.ts';
import { creditMaintenanceAmounts, creditMaintenanceDraft } from '../src/lib/credit/maintenance.ts';
import { creditInstitutionUpdateSchema } from '../src/lib/credit/update.ts';

async function allocate(db,name,amount,start,end,client='甲银行',closure=null) {
  const id=(await db.query(`INSERT INTO financing.bond(debt_type,subtype,name,amount,issue_date,maturity_date,settled_at)
    VALUES ('债券','小公募',$1,$2,$3,$4,$5) RETURNING id`,[name,amount*1e8,start,end,closure])).rows[0].id;
  await db.query(`INSERT INTO financing.bond_investors(bond_id,investor_id,amount)
    VALUES ($1,(SELECT id FROM public.client WHERE name=$2),$3)`,[id,client,amount*1e8]);
  return id;
}
const bond=r=>r.institutions[0].items.find(i=>i.type==='bond_investment');

test('numeric 金额从融资截面到授信详情保持一致，建信理财已用为22.2',async t=>{
  const db=await creditDatabase(t);
  await seedCredit(db,'2026-08-01','甲银行',{total:101.25,bond_investment_limit:47.22,bond_investment_secondary_used:-0.9});
  await allocate(db,'建信金额回归',23.1,'2026-08-01','2027-08-01');
  const report=await loadCreditReport(db,'2026-08-21');
  assert.equal(bond(report).usedAmount,22.2);
  assert.equal(bond(report).remainingAmount,25.02);
  const institution=report.institutions[0];
  const amounts=creditMaintenanceAmounts(institution,creditMaintenanceDraft(institution));
  assert.equal(amounts.used.bond_investment,bond(report).usedAmount);
  assert.equal(amounts.remaining.bond_investment,bond(report).remainingAmount);
  assert.equal(amounts.totalUsed,institution.totalUsed);
  assert.equal(amounts.available,institution.availableAmount);
  assert.equal(institution.availableAmount,79.05);
});

test('融资 numeric 元换算亿元不提前截断原始一级存续金额',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{});
  const id=await allocate(db,'保留分',1,'2026-08-01','2027-08-01');
  await db.query('UPDATE financing.bond_investors SET amount=$1 WHERE bond_id=$2',['100000001.01',id]);
  const data=await loadCreditData(db,'2026-08-21');
  assert.equal(data.usage.find(row=>row.date==='2026-08-21'&&row.item_type==='bond_investment').amount,1.0000000101);
});

test('原始一级存续变化101元仍生成日历和周比较，不被六位舍入漏掉',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{});
  await allocate(db,'小额一级变化',0.00000101,'2026-08-21','2027-08-21');
  const report=await loadCreditReport(db,'2026-08-21');
  assert.equal(report.calendarEvents.filter(e=>e.date==='2026-08-21'&&e.usageComponent==='primary').length,1);
  assert.ok(report.usageChanges.some(change=>change.details.some(detail=>detail.includes('一级发行'))));
});

test('一级存续按实际投资人汇总，发行、到期和提前结清触发已用变化，二级买卖可为负',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{bond_investment_secondary_used:-0.5});
  await allocate(db,'期一',2,'2026-08-20','2026-08-25');
  await allocate(db,'期二',3,'2026-08-21','2026-09-25','甲银行','2026-08-24');
  await allocate(db,'未知投资人',10,'2026-08-21','2026-09-25','不存在');
  const historical=await loadCreditReport(db,'2026-08-22');
  assert.equal(bond(historical).primaryUsedAmount,5);assert.equal(bond(historical).secondaryUsedAmount,-0.5);
  assert.equal(bond(historical).usedAmount,4.5);assert.equal(historical.summary.totalUsed,4.5);
  const r=await loadCreditReport(db,'2026-08-26');
  assert.equal(bond(r).primaryUsedAmount,0);assert.equal(bond(r).usedAmount,-0.5);
  assert.deepEqual(r.calendarEvents.filter(e=>e.usageComponent==='primary').map(e=>[e.date,e.label]),[
    ['2026-08-20','债券投资——一级发行 · 增加2亿元'],['2026-08-21','债券投资——一级发行 · 增加3亿元'],
    ['2026-08-24','债券投资——一级发行 · 减少3亿元'],['2026-08-25','债券投资——一级发行 · 减少2亿元'],
  ]);
});

test('一级和二级同日抵消仍逐项展示，二级编辑进入总已用与周比较且重复保存幂等',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{bond_investment_secondary_used:0});
  await allocate(db,'新发行',2,'2026-08-21','2027-08-21');
  const patch={reportDate:'2026-08-21',institutionName:'甲银行',changes:{items:[{type:'bond_investment',secondaryUsedAmount:-2}]}};
  await saveCreditInstitution(db,patch,'auth0|test');
  const before=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  await saveCreditInstitution(db,patch,'auth0|test');
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,before);
  const r=await loadCreditReport(db,'2026-08-21');assert.equal(r.summary.totalUsed,0);
  assert.equal(r.calendarEvents.filter(e=>e.date==='2026-08-21'&&e.type==='usage').length,2);
  assert.ok(r.calendarEvents.some(e=>e.usageComponent==='secondary'&&e.label==='债券投资——二级买卖 · 减少2亿元'));
  assert.equal(r.usageChanges.length,1);assert.equal(r.usageChanges[0].deltaAmount,0);
  assert.ok(r.usageChanges[0].details.some(d=>d.includes('二级买卖')));
  await saveCreditInstitution(db,{...patch,reportDate:'2026-08-22',changes:{items:[{type:'bond_investment',secondaryUsedAmount:0}]}},'auth0|test');
  assert.equal(bond(await loadCreditReport(db,'2026-08-22')).usedAmount,2);
});

test('非空历史迁移逐期保持真实余额，未变真实值也在到期后重算残差，退休分项归其它',async t=>{
  const db=await creditDatabase(t,false,true);
  await db.exec("INSERT INTO public.client(name,type) VALUES ('甲银行','银行')");
  await db.query(`SELECT credit.append_diff('2026-08-21','甲银行',$1::jsonb,NULL)`,[JSON.stringify({
    institution_type:'股份行',status:'approved',confidentiality_status:false,total:10,bond_investment_used:3,
    other_limit:1,other_used:0.5,other_detail:'原其它',margin_income_rights_limit:4,margin_income_rights_used:1,margin_income_rights_detail:'两融旧说明',
  })]);
  await db.query(`SELECT credit.append_diff('2026-08-28','甲银行','{"notes":"第二期，债券真实余额未变","margin_income_rights_used":0}'::jsonb,NULL)`);
  await allocate(db,'到期债券',2,'2026-01-01','2026-08-25');
  const original=(await db.query('SELECT to_jsonb(d) data FROM credit.diff d ORDER BY id')).rows;
  // Test rollback as well as successful application against populated rows.
  await db.exec('BEGIN');
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0009_bond_usage_and_other.sql',import.meta.url),'utf8'));
  assert.equal(Number((await db.query("SELECT bond_investment_secondary_used FROM credit.state_as_of('2026-08-21') WHERE institution_name='甲银行'")).rows[0].bond_investment_secondary_used),1);
  await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT to_jsonb(d) data FROM credit.diff d ORDER BY id')).rows,original);
  await db.exec(fs.readFileSync(new URL('../credit-migrations/0009_bond_usage_and_other.sql',import.meta.url),'utf8'));
  const retained=(await db.query('SELECT to_jsonb(d) data FROM credit.diff d WHERE id<=2 ORDER BY id')).rows;
  for(let i=0;i<retained.length;i++) {delete retained[i].data.bond_investment_secondary_used;assert.deepEqual(retained[i],original[i]);}
  // Verify 0009 itself against its historical schema before applying later corrections.
  for(const [date,primary,secondary,other] of [['2026-08-21',2,1,1.5],['2026-08-28',0,3,0.5]]) {
    const state=(await db.query('SELECT * FROM credit.state_as_of($1::date) WHERE institution_name=$2',[date,'甲银行'])).rows[0];
    const usage=(await db.query('SELECT amount::float8/100000000 AS amount FROM credit.bond_primary_usage_as_of($1::date) WHERE institution_name=$2',[date,'甲银行'])).rows[0]?.amount ?? 0;
    assert.equal(usage,primary);assert.equal(Number(state.bond_investment_secondary_used),secondary);
    assert.equal(usage+Number(state.bond_investment_secondary_used),3);
    assert.equal(Number(state.other_used),other);assert.equal(state.other_detail,'原其它；两融收益权转让：两融旧说明');
  }
  await finishCreditMigrations(db,'0009_bond_usage_and_other.sql');
  const current=await loadCreditReport(db,'2026-08-21');
  const item=current.institutions[0].items.find(i=>i.type==='other');
  assert.equal(item.limitAmount,null);assert.equal(item.details,'原其它；两融收益权转让：两融旧说明');
  assert.equal(current.institutions[0].items.some(i=>i.type==='margin_income_rights'),false);

});

test('旧台账导入按真实值登记残差；无客户关联非零值拒绝且回滚，不伪造为零',async t=>{
  const db=await creditDatabase(t);await seedCredit(db,'2026-08-01','甲银行',{bond_investment_secondary_used:0});
  await allocate(db,'发行',5,'2026-08-01','2027-08-01');
  const source=(await loadCreditReport(db,'2026-08-21')).institutions[0];source.items.find(i=>i.type==='bond_investment').usedAmount=3;
  const parsed={reportDate:'2026-08-21',institutions:[source],warnings:[]};
  await persistCreditWorkbook(db,{parsed,createdBy:'auth0|test'});
  const current=await loadCreditReport(db,'2026-08-21');assert.equal(bond(current).secondaryUsedAmount,-2);assert.equal(bond(current).usedAmount,3);
  assert.equal((await persistCreditWorkbook(db,{parsed,createdBy:'auth0|test'})).addedDiffCount,0);
  const missing={...source,institutionName:'未维护客户'};
  const before=(await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n;
  await assert.rejects(persistCreditWorkbook(db,{parsed:{...parsed,institutions:[missing]}}),/缺少客户关联/);
  assert.equal((await db.query('SELECT count(*) n FROM credit.entry')).rows[0].n,before);
});

test('API 只允许债券二级净余额输入，移除两融收益权转让并拒绝非有限数值',()=>{
  const valid=item=>creditInstitutionUpdateSchema.safeParse({operation:'maintenance',reportDate:'2026-09-10',institutionName:'甲',changes:{items:[item]}}).success;
  assert.equal(valid({type:'bond_investment',secondaryUsedAmount:-0.1}),true);
  assert.equal(valid({type:'bond_investment',usedAmount:1}),false);
  assert.equal(valid({type:'other',secondaryUsedAmount:1}),false);
  assert.equal(valid({type:'margin_income_rights',usedAmount:0}),false);
  assert.equal(valid({type:'bond_investment',secondaryUsedAmount:Infinity}),false);
});
