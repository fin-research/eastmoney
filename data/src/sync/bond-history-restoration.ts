import type { DatabaseClient } from './postgres.ts';
import { encodeExchangeBondCode } from './exchange-bond-code.ts';
import { createHash } from 'node:crypto';

export const HISTORY_FIELDS = ['YIELDCNBD', 'BONDBALANCE', 'MATUCNBD'] as const;
export type HistoryField = typeof HISTORY_FIELDS[number];
export type HistoryRequest = { date: string; codes: string[]; indicators: HistoryField[]; options: string };
export type RestoredBond = { bond_code: number; valuation_date: string; chinabond_yield_pct: number | null;
  outstanding_balance_cny: number | null; remaining_term_years: number | null };
export const observationKey = (code: string, date: string, field: string) => `${code}/${date}/${field}`;

type ReviewManifest = { assembledAt: string; failures: unknown[]; unknownRows: number;
  stats: Record<string, { failed: number }> } & Record<string, unknown>;
export function verifyHistoricalReview(manifest: ReviewManifest, expectedBytes: string,
  reviewedManifestBytes: string, reviewedRowsBytes: string, manifestSha: string, rowsSha: string) {
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const reviewed = JSON.parse(reviewedManifestBytes) as ReviewManifest;
  if (hash(reviewedManifestBytes) !== manifestSha || hash(reviewedRowsBytes) !== rowsSha || hash(expectedBytes) !== rowsSha
    || JSON.stringify({ ...manifest, assembledAt: reviewed.assembledAt }) !== JSON.stringify(reviewed))
    throw Error('Reviewed historical manifest/rows changed');
  if (manifest.failures.length || manifest.unknownRows || Object.values(manifest.stats).some(stat => stat.failed))
    throw Error('Historical capture incomplete; refusing partial apply');
}

/** A missing response row/field is a contract failure, not a quoted NULL. */
export function historicalCells(raw: unknown, request: HistoryRequest): Map<string, number | null> {
  const data = raw as { function?: string; rows?: Record<string, unknown>[] };
  if (data?.function !== 'CSS' || !Array.isArray(data.rows) || data.rows.length !== request.codes.length)
    throw Error('Incomplete historical CSS response');
  const seen = new Set<string>(), cells = new Map<string, number | null>();
  for (const row of data.rows) {
    const code = String(row.code ?? '');
    if (!request.codes.includes(code) || seen.has(code)) throw Error('Wrong/duplicate historical CSS code');
    seen.add(code);
    for (const field of request.indicators) {
      const value = row[field];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)
        || (field !== 'YIELDCNBD' && value < 0))) throw Error('Invalid/missing historical CSS value');
      cells.set(observationKey(code, request.date, field), value as number | null);
    }
  }
  return cells;
}

export function historicalRows(matrix: Array<{ date: string; codes: string[] }>, cells: Map<string, number | null>) {
  const rows: RestoredBond[] = [];
  const stats: Record<string, { requested: number; valid: number; null: number; failed: number }> = {};
  for (const { date, codes } of matrix) for (const code of codes) {
    const values = HISTORY_FIELDS.map(field => {
      const stat = stats[`${date.slice(0, 4)}/${field}`] ??= { requested: 0, valid: 0, null: 0, failed: 0 };
      stat.requested++;
      const key = observationKey(code, date, field);
      if (!cells.has(key)) { stat.failed++; return null; }
      const value = cells.get(key)!;
      if (value === null) stat.null++; else stat.valid++;
      return value;
    });
    if (values.some(value => value !== null)) rows.push({ bond_code: encodeExchangeBondCode(code)!,
      valuation_date: date, chinabond_yield_pct: values[0]!, outstanding_balance_cny: values[1]!, remaining_term_years: values[2]! });
  }
  return { rows, stats };
}

/** This controlled restoration only fills a frozen, empty date/code window. */
export async function insertHistoricalBonds(db: DatabaseClient, rows: RestoredBond[], matrix: Array<{ date: string; codes: string[] }>) {
  const dates = matrix.map(row => row.date);
  const codes = [...new Set(matrix.flatMap(row => row.codes.map(code => encodeExchangeBondCode(code)!)))];
  const allowed = new Set(matrix.flatMap(row => row.codes.map(code => `${row.date}/${encodeExchangeBondCode(code)}`)));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.valuation_date}/${row.bond_code}`;
    if (!allowed.has(key) || keys.has(key))
      throw Error('Historical insert outside frozen scope or duplicate key');
    keys.add(key);
  }
  await db.query('BEGIN');
  try {
    // Prevent daily sync/other imports from racing the empty-before assertion.
    await db.query('LOCK TABLE public.bond_history IN SHARE ROW EXCLUSIVE MODE');
    const before = await db.query(`SELECT 1 FROM public.bond_history
      WHERE valuation_date=ANY($1::date[]) AND bond_code=ANY($2::integer[]) LIMIT 1`, [dates, codes]);
    if (before.rows.length) throw Error('Historical before-image changed; refusing overwrite');
    let inserted = 0;
    for (let offset = 0; offset < rows.length; offset += 5000) {
      const batch = rows.slice(offset, offset + 5000);
      const result = await db.query(`INSERT INTO public.bond_history
        (bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years)
        SELECT bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years
        FROM jsonb_to_recordset($1::jsonb) x(bond_code integer,valuation_date date,
          chinabond_yield_pct double precision,outstanding_balance_cny double precision,remaining_term_years double precision)`,
      [JSON.stringify(batch)]);
      if (result.rowCount !== batch.length) throw Error('Historical insert count mismatch');
      inserted += result.rowCount;
    }
    await db.query('COMMIT');
    return { inserted };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}
