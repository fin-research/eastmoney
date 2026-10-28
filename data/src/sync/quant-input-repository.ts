import type { DatabaseClient } from './postgres.ts';
import type { QuantInput } from './quant-input-contract.ts';

export async function persistQuantInputs(client: DatabaseClient, rows: QuantInput[], insertOnly = false): Promise<number> {
  if (rows.some(row => row.dataset === 'issue' || row.dataset === 'issue_pricing_quarantine' || row.entityKey)) {
    throw new Error('Bond-level inputs belong in bond_issuance');
  }
  if (rows.some(row => row.textValue !== null || row.numericValue === null || !Number.isFinite(row.numericValue))) {
    throw new Error('quant_input accepts only finite numeric values');
  }
  let count = 0;
  await client.query('BEGIN');
  try {
    for (let offset = 0; offset < rows.length; offset += 1500) {
      const batch = rows.slice(offset, offset + 1500);
      const result = await client.query(`INSERT INTO public.quant_input
        (field,observation_date,numeric_value,published_date)
        SELECT field,"observationDate"::date,"numericValue","publishedDate"::date
        FROM jsonb_to_recordset($1::jsonb) AS x(field text,"observationDate" text,
          "numericValue" double precision,"publishedDate" text)
        ON CONFLICT (field,observation_date) ${insertOnly ? 'DO NOTHING' : `DO UPDATE SET
          numeric_value=EXCLUDED.numeric_value,published_date=EXCLUDED.published_date
          WHERE (quant_input.numeric_value,quant_input.published_date)
            IS DISTINCT FROM (EXCLUDED.numeric_value,EXCLUDED.published_date)`}`,
      [JSON.stringify(batch)]);
      count += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return count;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
