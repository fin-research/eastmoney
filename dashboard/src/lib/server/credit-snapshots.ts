import type { DatabaseClient } from './postgres.ts';

export type CreditStateRequest = { date: string; names: string[] | null; include_details?: boolean };
export type CreditStateRow = { date: string; position: number; data: import('../credit/data.ts').CreditDataState['data'] };

/** DISTINCT ON over typed entries is the only source of field inheritance. */
export async function loadCreditStates(client: DatabaseClient, requests: CreditStateRequest[]): Promise<CreditStateRow[]> {
  if (!requests.length) return [];
  return (await client.query<CreditStateRow>(`
    SELECT to_char(r.date,'YYYY-MM-DD') AS date,s.institution_id::float8 AS position,
      CASE WHEN coalesce(r.include_details,true) THEN to_jsonb(s) ELSE to_jsonb(s)-
        '{notes,bank_office,applying_department,handler,detail,bond_preference,updated_at,created_at,bond_investment_used}'::text[] END AS data
    FROM jsonb_to_recordset($1::jsonb) r(date date,names text[],include_details boolean)
    CROSS JOIN LATERAL credit.entry_as_of(r.date,r.names) s
    ORDER BY r.date,s.institution_id
  `,[JSON.stringify(requests)])).rows;
}
