import fs from 'node:fs';
import { Client } from 'pg';
import { loadCreditReport } from '../src/lib/server/credit-repository.ts';

const outputPath=process.argv.slice(2).find(arg=>!arg.startsWith('--'));
const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15_000,application_name:'eastmoney-client-reconciliation'});
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const report={generatedAt:new Date().toISOString()};
  report.clients=(await db.query('SELECT id::text,name,fullname,type,subtype FROM public.client ORDER BY type,name')).rows;
  report.coverage=(await db.query(`SELECT count(*) AS debt_count,count(client_id) AS linked_count,
    count(*) FILTER(WHERE counterparty IS NOT NULL AND client_id IS NULL) AS named_unlinked_count,
    count(*) FILTER(WHERE counterparty IS NULL) AS missing_name_count FROM financing.debt`)).rows[0];
  const dates=(await db.query("SELECT DISTINCT report_date::text AS date FROM credit.entry ORDER BY date")).rows.map(row=>row.date);
  report.reconciliation=[];
  for(const date of dates){
    const snapshot=await loadCreditReport(db,date);
    for(const institution of snapshot.institutions) for(const item of institution.items.filter(item=>item.usageSource==='financing')) {
      report.reconciliation.push({date,institutionName:institution.institutionName,itemType:item.type,
        usedAmount:item.usedAmount,linkedClientCount:item.linkedClientCount,status:item.usedAmount==null?'unlinked':'derived'});
    }
  }
  report.unlinked=(await db.query(`SELECT id::text,debt_type,name,counterparty,amount::float8,
    to_char(issue_date,'YYYY-MM-DD') AS issue_date,to_char(maturity_date,'YYYY-MM-DD') AS maturity_date
    FROM financing.debt WHERE client_id IS NULL ORDER BY debt_type,id`)).rows;
  report.creditMappings=(await db.query(`SELECT m.institution_name,c.name AS client_name,c.type AS client_type,m.notes
    FROM credit.institution_client m JOIN public.client c ON c.id=m.client_id ORDER BY m.institution_name,c.name`)).rows;
  report.latestOutstanding=(await db.query(`SELECT c.name,c.type,u.debt_type,(u.amount/100000000)::float8 AS amount_yi,u.debt_count::integer,
    m.institution_name FROM financing.credit_usage_as_of((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) u
    LEFT JOIN public.client c ON c.id=u.client_id
    LEFT JOIN credit.institution_client m ON m.client_id=u.client_id
    ORDER BY c.type,c.name,u.debt_type`)).rows;
  await db.query('COMMIT');
  if(outputPath) fs.writeFileSync(outputPath,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({clients:report.clients.length,coverage:report.coverage,
    missingAssociations:report.reconciliation.filter(r=>r.status==='unlinked'),
    output:outputPath??null},null,2));
} finally {await db.end();}
