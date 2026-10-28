// Bounded, repeatable metadata repair. No upstream requests and no value changes.
import { Client } from 'pg';
import { HISTORICAL_RELEASE_EVIDENCE } from '../src/sync/economic-release-evidence.ts';

const client = new Client({
  connectionString: process.env.DATABASE_URL ?? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE,
  connectionTimeoutMillis: 20000,
  query_timeout: 60000,
});
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('public.edb.sync', 0))");
  let missing = 0;
  for (const row of HISTORICAL_RELEASE_EVIDENCE) {
    const result = await client.query(
      `SELECT to_char(published_date, 'YYYY-MM-DD') AS published FROM public.edb
       WHERE indicator_code=$1 AND observation_date=$2::date FOR UPDATE`,
      [row.indicator_code, row.observation_date],
    );
    if (result.rowCount !== 1) throw new Error('Expected historical observation missing');
    const current = result.rows[0].published;
    if (current !== null && current !== row.published_date) throw new Error('Conflicting release date; unchanged');
    if (current === null) missing++;
  }
  let updated = 0;
  if (process.argv.includes('--apply')) {
    const result = await client.query(
      `UPDATE public.edb e SET published_date=x.published_date::date
       FROM jsonb_to_recordset($1::jsonb) AS x(indicator_code text, observation_date text, published_date text)
       WHERE e.indicator_code=x.indicator_code AND e.observation_date=x.observation_date::date
         AND e.published_date IS NULL`,
      [JSON.stringify(HISTORICAL_RELEASE_EVIDENCE)],
    );
    updated = result.rowCount ?? 0;
    if (updated !== missing) throw new Error('Unexpected update count');
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ evidence: HISTORICAL_RELEASE_EVIDENCE.length, missing, updated }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
