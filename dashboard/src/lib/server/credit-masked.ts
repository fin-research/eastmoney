import { creditMaskedReportSchema } from '../credit/masked.ts';
import { CreditDatabaseError } from './credit-repository.ts';
import type { DatabaseClient } from './postgres.ts';

const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export async function loadCreditMasked(client: DatabaseClient, date?: string, institutionId?: string) {
  const reportDate = date ?? businessDate.format(new Date());
  const coverage = await client.query<{ covered: boolean }>('SELECT EXISTS(SELECT 1 FROM credit.entry WHERE report_date<=$1::date) AS covered', [reportDate]);
  if (!coverage.rows[0]?.covered) throw new CreditDatabaseError(404, '该日暂无授信记录');
  const result = await client.query(`SELECT institution_id::text,status,
    to_char(effective_date,'YYYY-MM-DD') AS effective_date,to_char(expiry_date,'YYYY-MM-DD') AS expiry_date,
    total_limit::text,total_used::text,total_available::text,utilization_pct::text,
    bond_investment_limit::text,bond_primary_used::text,bond_secondary_used::text,bond_investment_used::text,
    yield_certificate_limit::text,yield_certificate_used::text,interbank_lending_limit::text,interbank_lending_used::text,
    legal_overdraft_limit::text,legal_overdraft_used::text,other_used::text,verified
    FROM credit.masked_as_of($1::date) WHERE ($2::bigint IS NULL OR institution_id=$2::bigint) ORDER BY institution_id`, [reportDate, institutionId ?? null]);
  return creditMaskedReportSchema.parse({ reportDate, amountUnit: '亿元', institutions: result.rows });
}
