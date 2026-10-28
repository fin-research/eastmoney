/** Scoped, insert-only repair for workbook LCR/NSFR observations. No upstream calls. */
import { Client } from 'pg';
import { readQuantWorkbooks } from './quant-workbook-inputs.ts';
import { persistQuantInputs } from '../src/sync/quant-input-repository.ts';
import { sourceDate } from '../src/sync/quant-input-contract.ts';

const argv = process.argv.slice(2);
function option(name: string): string | null {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
}

const directory = option('--directory');
const start = option('--start');
const end = option('--end');
const apply = argv.includes('--apply');
if (!directory || !start || !end || sourceDate(start) !== start || sourceDate(end) !== end || start > end) {
  throw new Error('Required: --directory <quant/data> --start YYYY-MM-DD --end YYYY-MM-DD');
}
const windowDays = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
if (windowDays >= 31) throw new Error('A single repair window may not exceed 31 calendar days');

const parsed = await readQuantWorkbooks(directory, end);
const workbook = parsed.manifest.find(row => row.sourceKey === '业务数据.xlsx');
if (!workbook) throw new Error('Missing company liquidity workbook manifest');
const rows = parsed.inputs.filter(row =>
  row.dataset === 'company' && row.entityKey === '' &&
  (row.field === 'lcr' || row.field === 'nsfr') &&
  row.sourceKey === '业务数据.xlsx' && row.observationDate >= start && row.observationDate <= end &&
  row.numericValue !== null,
);
const keys = new Set(rows.map(row => `${row.field}:${row.observationDate}`));
if (!rows.length || keys.size !== rows.length) throw new Error('Missing or duplicated scoped liquidity observations');
const dates = [...new Set(rows.map(row => row.observationDate))].sort();
if (dates.some(date => !keys.has(`lcr:${date}`) || !keys.has(`nsfr:${date}`))) {
  throw new Error('Both LCR and NSFR are required for every scoped workbook date');
}

const connectionString = process.env.DATABASE_URL ?? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) throw new Error('Database connection is required');
const client = new Client({ connectionString, connectionTimeoutMillis: 20_000, query_timeout: 60_000 });
try {
  await client.connect();
  const current = await client.query<{field:string; observation_date:string; numeric_value:number}>(
    `SELECT field, observation_date::text, numeric_value FROM public.quant_input
     WHERE field=ANY($1::text[])
       AND observation_date BETWEEN $2::date AND $3::date`,
    [['lcr', 'nsfr'], start, end],
  );
  const existing = new Map(current.rows.map(row => [`${row.field}:${row.observation_date}`, row.numeric_value]));
  for (const row of rows) {
    const value = existing.get(`${row.field}:${row.observationDate}`);
    if (value !== undefined && Math.abs(value - row.numericValue!) > 1e-9) {
      throw new Error(`Existing ${row.field} observation differs on ${row.observationDate}; no overwrite performed`);
    }
  }
  const pending = rows.filter(row => !existing.has(`${row.field}:${row.observationDate}`));
  const audit = {
    mode: apply ? 'apply' : 'dry-run', start, end, sourceKey: workbook.sourceKey,
    sourceHash: workbook.sourceHash, workbookDates: dates, sourceRows: rows.length,
    existingRows: existing.size, missingRows: pending.length,
    missingKeys: pending.map(row => `${row.field}:${row.observationDate}`),
    choiceCalls: 0, existingValuesPreserved: true,
  };
  if (!apply) {
    console.log(JSON.stringify(audit));
  } else {
    const expectedHash = option('--expected-source-hash');
    const missingCountText = option('--expected-missing-count');
    const expectedMissing = missingCountText === null ? NaN : Number(missingCountText);
    if (expectedHash !== workbook.sourceHash || !Number.isInteger(expectedMissing) || expectedMissing !== pending.length) {
      throw new Error('Apply requires matching --expected-source-hash and --expected-missing-count from dry-run');
    }
    const inserted = await persistQuantInputs(client, pending, true);
    if (inserted !== pending.length) throw new Error('Insert count changed; inspect concurrent writes before retrying');
    console.log(JSON.stringify({ ...audit, inserted }));
  }
} finally {
  await client.end();
}
