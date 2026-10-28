import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { isNarrativeOnlyDebt } from '../../src/lib/financing/debt-import-rules.js';

export function isCleanupCandidate(row) {
 const ignored = new Set(['id','debt_type','subtype','name','amount','interest_payable','total_amount','term_days','status','created_at','updated_at']);
 return row.physical_table === 'financing.bond'
  && isNarrativeOnlyDebt({debtType:row.data.debt_type,name:row.data.name,amount:row.data.amount,interestPayable:row.data.interest_payable})
  && Object.entries(row.data).every(([key,value])=>ignored.has(key)||value===null);
}

async function inventory(db, excluded=[]) {
 return (await db.query(`WITH physical_debts AS (
  ${['debt','bond','income_certificate','income_right','refinancing','swap_facility'].map(table=>`SELECT '${table}' AS physical_table,id,to_jsonb(d) AS data FROM ONLY financing.${table} d`).join(' UNION ALL ')}
 ) SELECT
  (SELECT count(*) FROM financing.debt) AS debt_count,
  (SELECT sum(amount)::text FROM financing.debt) AS principal,
  (SELECT sum(interest_payable)::text FROM financing.debt) AS interest,
  (SELECT min(issue_date)::text FROM financing.debt) AS first_issue,
  (SELECT max(maturity_date)::text FROM financing.debt) AS last_maturity,
  (SELECT md5(coalesce(string_agg(physical_table || ':' || data::text,',' ORDER BY physical_table,id),'')) FROM physical_debts WHERE NOT(id=ANY($1::bigint[]))) AS other_debts,
  (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY debt_id,sequence),'')) FROM financing.cashflow c) AS cashflows,
  (SELECT md5(coalesce(string_agg(to_jsonb(b)::text,',' ORDER BY as_of_date,debt_type,subtype),'')) FROM financing.balance_snapshot b) AS balances,
  (SELECT md5(coalesce(string_agg(to_jsonb(m)::text,',' ORDER BY month_end),'')) FROM financing.monthly_financing_metrics m) AS monthly`,[excluded])).rows[0];
}

export async function cleanupDebtNarratives(db,{apply=false,backupPath,planPath,rollback=false}={}) {
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 try {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('financing.local_debt_maintenance'))");
  const possible=(await db.query(`SELECT tableoid::regclass::text AS physical_table,to_jsonb(d) AS data
   FROM ONLY financing.bond d WHERE amount=0 AND interest_payable=0
   AND issue_date IS NULL AND maturity_date IS NULL ORDER BY id FOR UPDATE`)).rows;
  const candidates=possible.filter(isCleanupCandidate);
  const ids=candidates.map(row=>String(row.data.id));
  const references=(await db.query('SELECT * FROM financing.cashflow WHERE debt_id=ANY($1::bigint[])',[ids])).rows;
  if(references.length)throw new Error('说明型负债存在现金流引用，停止清理');
  const before=await inventory(db,ids);
  if(!apply){await db.query('ROLLBACK');return {mode:'dry-run',candidates,before};}
  if(!backupPath || !planPath)throw new Error('写入前必须指定 --plan=<盘点文件> 和 --backup=<绝对路径>');
  const reviewed=JSON.parse(fs.readFileSync(planPath,'utf8'));
  if(JSON.stringify(reviewed.candidates)!==JSON.stringify(candidates))throw new Error('候选记录已变化，请重新盘点');
  const backup={createdAt:new Date().toISOString(),candidates,cashflows:references,before};
  fs.writeFileSync(backupPath,JSON.stringify(backup,null,2)+'\n',{flag:'wx',mode:0o600});
  let deleted=0;
  for(const row of candidates){
   const result=await db.query('DELETE FROM financing.bond d WHERE id=$1 AND to_jsonb(d)=$2::jsonb RETURNING id',[row.data.id,JSON.stringify(row.data)]);
   if(result.rowCount!==1)throw new Error(`负债 ${row.data.id} 已变化，停止清理`);
   deleted+=result.rowCount;
  }
  const after=await inventory(db,ids);
  for(const key of Object.keys(before)){
   if(key==='debt_count'){if(Number(before[key])-Number(after[key])!==deleted)throw new Error('负债数量核对失败');}
   else if(before[key]!==after[key])throw new Error(`${key} 核对失败`);
  }
  await db.query(rollback?'ROLLBACK':'COMMIT');
  return {mode:rollback?'rollback':'committed',deleted,ids,backupPath,before,after};
 }catch(error){await db.query('ROLLBACK');throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.env.DATABASE_URL)throw new Error('缺少 DATABASE_URL');
 const db=new Client({connectionString:process.env.DATABASE_URL,application_name:'financing-narrative-cleanup'});
 await db.connect();
 try {console.log(JSON.stringify(await cleanupDebtNarratives(db,{
  apply:process.argv.includes('--apply'),rollback:process.argv.includes('--rollback'),
  backupPath:process.argv.find(arg=>arg.startsWith('--backup='))?.slice(9),
  planPath:process.argv.find(arg=>arg.startsWith('--plan='))?.slice(7)
 }),null,2));}finally{await db.end();}
}
