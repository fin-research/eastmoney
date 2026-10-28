import fs from 'node:fs/promises';
import { Client } from 'pg';
import { loadCreditReport } from '../src/lib/server/credit-repository.ts';

const args=process.argv.slice(2);
const date=args[args.indexOf('--date')+1];
if(!args.includes('--date') || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) {
  throw new Error('用法：node scripts/reconcile-credit-bond-usage.mjs --date YYYY-MM-DD [--output /absolute/report.json]');
}
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db=new Client({connectionString:process.env.DATABASE_URL,application_name:'credit-bond-reconciliation',connectionTimeoutMillis:15000});
try {
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const report=await loadCreditReport(db,date);
  const reference=(await db.query('SELECT institution_name,bond_investment_used FROM credit.entry_as_of($1)',[date])).rows;
  const rows=report.institutions.map(institution=>{
    const item=institution.items.find(item=>item.type==='bond_investment');
    return {institutionName:institution.institutionName,status:institution.status,linkedClientCount:item.linkedClientCount,
      ledgerReference:Number(reference.find(row=>row.institution_name===institution.institutionName)?.bond_investment_used??0),
      primaryUsedAmount:item.primaryUsedAmount,secondaryUsedAmount:item.secondaryUsedAmount,usedAmount:item.usedAmount};
  });
  const residuals=rows.filter(row=>Math.abs(row.secondaryUsedAmount??0)>0.000001)
    .sort((a,b)=>Math.abs(b.secondaryUsedAmount)-Math.abs(a.secondaryUsedAmount));
  const output={reportDate:date,unit:'亿元',institutionCount:rows.length,residualCount:residuals.length,
    netSecondaryUsedAmount:Math.round(residuals.reduce((sum,row)=>sum+row.secondaryUsedAmount,0)*1e6)/1e6,
    unlinked:rows.filter(row=>!row.linkedClientCount),residuals,rows};
  await db.query('COMMIT');
  if(args.includes('--output')) await fs.writeFile(args[args.indexOf('--output')+1],JSON.stringify(output,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(output,null,2));
} finally {await db.end().catch(()=>undefined);}
