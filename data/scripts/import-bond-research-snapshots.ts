/** Replay frozen local bond snapshots into separate Neon research-input tables.
 * No Choice request is made. Dry-run is the default; --apply is explicit.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { Client } from 'pg';
import { encodeExchangeBondCode } from '../src/sync/exchange-bond-code.ts';

type Kind = 'csd' | 'issuer' | 'curve';
type HistoryRow = {
  bond_code: number; valuation_date: string; chinabond_yield_pct: number | null;
  outstanding_balance_cny: number | null; remaining_term_years: number | null;
};
type CurveRow = {
  curve_code: string; curve_name: string; observation_date: string;
  tenor_years: number; yield_pct: number; node_label: string | null;
};
const CURVE_CODE = '5781a1ff7651967e0176978d957b7346';
const CURVE_NAME = '中债证券公司债收益率曲线(AAA)';
const BATCH_SIZE = 1000;

function argumentsOf(command: string[]) {
  const files: Array<{kind: Kind; path: string}> = [];
  let apply = false;
  for (let index = 0; index < command.length; index++) {
    const arg = command[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--csd-file' || arg === '--issuer-file' || arg === '--curve-file') {
      const path = command[++index];
      if (!path) throw new Error(`Missing path after ${arg}`);
      files.push({kind: arg.slice(2, -5) as Kind, path});
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!files.length) throw new Error('Specify input files');
  if (new Set(files.map(file => file.kind)).size !== files.length) throw new Error('Duplicate file kind');
  return {files, apply};
}

function cells(line: string): string[] {
  const result: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { result.push(cell); cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('Multiline CSV cells are unsupported by this importer');
  result.push(cell);
  return result;
}

function numberOrNull(raw: string | undefined): number | null {
  if (!raw || raw === 'NaN' || raw === 'nan' || raw === '--') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric observation: ${raw}`);
  return value;
}

function dateValue(raw: string | undefined): string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new Error(`Invalid observation date: ${raw ?? ''}`);
  }
  return raw;
}

function rowOf(kind: Kind, header: Map<string, number>, values: string[]): HistoryRow | CurveRow | null {
  const value = (name: string): string => {
    const index = header.get(name);
    if (index === undefined) throw new Error(`Missing source column: ${name}`);
    return values[index] ?? '';
  };
  if (kind === 'curve') {
    const tenor = numberOrNull(value('tenor_years'));
    const yieldPct = numberOrNull(value('yield_pct'));
    if (tenor === null || tenor <= 0 || yieldPct === null) return null;
    return {curve_code: CURVE_CODE, curve_name: CURVE_NAME,
      observation_date: dateValue(value('date')), tenor_years: tenor,
      yield_pct: yieldPct, node_label: value('node') || null};
  }
  const code = value('code').trim().toUpperCase();
  if (code.endsWith('.IB')) return null;
  const encoded = encodeExchangeBondCode(code);
  const date = dateValue(value('date'));
  const yieldPct = numberOrNull(value(kind === 'csd' ? 'YIELDCNBD' : 'yield_pct'));
  const term = numberOrNull(value(kind === 'csd' ? 'REMAININGTERMYEAR' : 'remaining_years'));
  const balance = kind === 'issuer' ? numberOrNull(value('balance_raw')) : null;
  if (balance !== null && balance < 0) throw new Error(`Negative bond balance: ${code}/${date}`);
  if (term !== null && term < 0) throw new Error(`Negative remaining term: ${code}/${date}`);
  if (yieldPct === null && term === null && balance === null) return null;
  return {bond_code: encoded, valuation_date: date, chinabond_yield_pct: yieldPct,
    outstanding_balance_cny: balance, remaining_term_years: term};
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeHistory(client: Client, rows: HistoryRow[]): Promise<number> {
  const result = await client.query(`INSERT INTO public.bond_history (
      bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years)
    SELECT bond_code,valuation_date::date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years
    FROM jsonb_to_recordset($1::jsonb) AS x(
      bond_code integer,valuation_date text,chinabond_yield_pct double precision,
      outstanding_balance_cny double precision,remaining_term_years double precision)
    ON CONFLICT (bond_code,valuation_date) DO UPDATE SET
      chinabond_yield_pct=coalesce(excluded.chinabond_yield_pct,bond_history.chinabond_yield_pct),
      outstanding_balance_cny=coalesce(excluded.outstanding_balance_cny,bond_history.outstanding_balance_cny),
      remaining_term_years=coalesce(excluded.remaining_term_years,bond_history.remaining_term_years)
    WHERE (bond_history.chinabond_yield_pct,bond_history.outstanding_balance_cny,
      bond_history.remaining_term_years) IS DISTINCT FROM
      (coalesce(excluded.chinabond_yield_pct,bond_history.chinabond_yield_pct),
      coalesce(excluded.outstanding_balance_cny,bond_history.outstanding_balance_cny),
      coalesce(excluded.remaining_term_years,bond_history.remaining_term_years))`, [JSON.stringify(rows)]);
  return result.rowCount ?? 0;
}

async function writeCurve(client: Client, rows: CurveRow[]): Promise<number> {
  const result = await client.query(`INSERT INTO public.bond_industry_curve (
      curve_code,curve_name,observation_date,tenor_years,yield_pct,node_label)
    SELECT curve_code,curve_name,observation_date::date,tenor_years,yield_pct,node_label
    FROM jsonb_to_recordset($1::jsonb) AS x(curve_code text,curve_name text,observation_date text,
      tenor_years double precision,yield_pct double precision,node_label text)
    ON CONFLICT (curve_code,observation_date,tenor_years) DO UPDATE SET
      curve_name=excluded.curve_name,yield_pct=excluded.yield_pct,node_label=excluded.node_label
    WHERE (bond_industry_curve.curve_name,bond_industry_curve.yield_pct,bond_industry_curve.node_label) IS DISTINCT FROM
      (excluded.curve_name,excluded.yield_pct,excluded.node_label)`,
  [JSON.stringify(rows)]);
  return result.rowCount ?? 0;
}

async function replay(kind: Kind, path: string, client: Client | null) {
  const digest = await sha256(path);
  const stream = createReadStream(path).pipe(path.endsWith('.gz') ? createGunzip() : new PassThrough());
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  let header: Map<string, number> | null = null;
  let scanned = 0, eligible = 0, changed = 0;
  let batch: Array<HistoryRow | CurveRow> = [];
  for await (const line of lines) {
    if (!header) { header = new Map(cells(line).map((name, index) => [name, index])); continue; }
    scanned++;
    const row = rowOf(kind, header, cells(line));
    if (!row) continue;
    eligible++;
    if (!client) continue;
    batch.push(row);
    if (batch.length === BATCH_SIZE) {
      changed += kind === 'curve' ? await writeCurve(client, batch as CurveRow[]) : await writeHistory(client, batch as HistoryRow[]);
      batch = [];
    }
  }
  if (client && batch.length) changed += kind === 'curve' ? await writeCurve(client, batch as CurveRow[]) : await writeHistory(client, batch as HistoryRow[]);
  return {kind, source: path, sha256: digest, scanned, eligible, changed};
}

import { PassThrough } from 'node:stream';

const command = argumentsOf(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL ?? process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (command.apply && !connectionString) throw new Error('DATABASE_URL or Hyperdrive local connection is required');
const client = command.apply ? new Client({connectionString, application_name: 'bond-research-snapshot-import'}) : null;
try {
  if (client) {
    await client.connect();
    const migration = await client.query("SELECT 1 FROM public.edb_schema_migration WHERE name='0010_compact_quant_inputs.sql'");
    if (!migration.rowCount) throw new Error('Apply edb migration 0010 before importing snapshots');
  }
  const sources = [];
  for (const file of command.files) sources.push(await replay(file.kind, file.path, client));
  console.log(JSON.stringify({mode: command.apply ? 'applied' : 'plan', sources}, null, 2));
} finally { await client?.end(); }
