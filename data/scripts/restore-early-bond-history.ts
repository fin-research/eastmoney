/** Offline assembly and insert-only restoration from exact captured historical requests. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { HISTORY_FIELDS, historicalCells, historicalRows, insertHistoricalBonds, observationKey,
  verifyHistoricalReview, type HistoryRequest } from '../src/sync/bond-history-restoration.ts';

const [directory, action, reviewedManifestSha, reviewedRowsSha] = process.argv.slice(2);
if (!directory || (action && action !== '--apply')
  || (action === '--apply' && (!/^[a-f0-9]{64}$/.test(reviewedManifestSha ?? '') || !/^[a-f0-9]{64}$/.test(reviewedRowsSha ?? ''))))
  throw Error('Usage: restore-early-bond-history.ts CACHE_DIR [--apply REVIEWED_MANIFEST_SHA REVIEWED_ROWS_SHA]');
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const read = (file: string) => readFile(path.join(directory, file), 'utf8');
const planBytes = await read('collection-plan.json'), plan = JSON.parse(planBytes);
const matrixBytes = await read('matrix.json'), bondsBytes = await read('bonds.json'), beforeBytes = await read('before.json');
if (hash(matrixBytes) !== plan.matrixSha256 || hash(bondsBytes) !== plan.bondsSha256
  || hash(beforeBytes) !== plan.beforeSha256 || beforeBytes.trim() !== '[]') throw Error('Frozen input changed/not empty');
const matrix: Array<{ date: string; codes: string[] }> = JSON.parse(matrixBytes);
const bonds: Array<{ code: string; issue_date: string; maturity_date: string | null }> = JSON.parse(bondsBytes);
const dates: string[] = JSON.parse(await read('dates.json'));
if (bonds.length !== 470 || dates.length !== 459 || new Set(dates).size !== dates.length
  || dates.some(date => date < '2019-01-02' || date > '2020-11-05')) throw Error('Wrong historical scope');
const expected = dates.map(date => ({ date, codes: bonds.filter(b => b.issue_date <= date
  && (!b.maturity_date || b.maturity_date >= date)).map(b => b.code) })).filter(r => r.codes.length);
if (JSON.stringify(matrix) !== JSON.stringify(expected)) throw Error('Historical matrix changed');
const cells = new Map<string, number | null>(), sources: Array<Record<string, unknown>> = [];
const add = (incoming: Map<string, number | null>) => {
  for (const [key, value] of incoming) {
    if (cells.has(key)) throw Error(`Duplicate paid/cache cell: ${key}`);
    cells.set(key, value);
  }
};
for (const file of plan.priorSourceFiles as string[]) {
  const bytes = await readFile(file, 'utf8'), receipt = JSON.parse(bytes);
  const params = receipt.params, date = /(?:^|,)EndDate=(\d{4}-\d{2}-\d{2})(?:,|$)/.exec(params.options)?.[1];
  if (receipt.status !== 200 || !date || !dates.includes(date)) throw Error('Invalid cached historical receipt');
  const request: HistoryRequest = { date, codes: params.codes.split(','), indicators: params.indicators.split(','), options: params.options };
  add(historicalCells(JSON.parse(receipt.rawBody), request));
  sources.push({ file, sha256: hash(bytes), capturedAt: receipt.time });
}
const planned = new Set(cells.keys());
for (const request of plan.requests as HistoryRequest[]) for (const code of request.codes) for (const field of request.indicators) {
  const key = observationKey(code, request.date, field);
  if (planned.has(key)) throw Error('Duplicate request or cached cell');
  planned.add(key);
}
const allExpected = new Set(matrix.flatMap(r => r.codes.flatMap(code => HISTORY_FIELDS.map(f => observationKey(code, r.date, f)))));
if (planned.size !== allExpected.size || [...planned].some(key => !allExpected.has(key))) throw Error('Incomplete/extra planned matrix');
const failures = [];
for (let index = 0; index < plan.requests.length; index++) {
  const file = `responses/${String(index).padStart(4, '0')}.json`;
  let bytes: string;
  try { bytes = await read(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    failures.push({ index, kind: 'not attempted' }); continue;
  }
  const receipt = JSON.parse(bytes), request = plan.requests[index] as HistoryRequest;
  if (receipt.planSha256 !== hash(planBytes) || receipt.index !== index
    || JSON.stringify(receipt.request) !== JSON.stringify(request)
    || receipt.params?.codes !== request.codes.join(',') || receipt.params?.indicators !== request.indicators.join(',')
    || receipt.params?.options !== request.options) throw Error('Historical receipt identity mismatch');
  sources.push({ file, sha256: hash(bytes), rawSha256: receipt.rawSha256, capturedAt: receipt.startedAt, status: receipt.status });
  if (receipt.status !== 200 || receipt.error) { failures.push({ index, status: receipt.status, error: receipt.error }); continue; }
  if (hash(receipt.rawBody) !== receipt.rawSha256) throw Error('Historical raw response hash mismatch');
  add(historicalCells(JSON.parse(receipt.rawBody), request));
}
const { rows, stats } = historicalRows(matrix, cells);
const perBondStats: Record<string, Record<string, { requested: number; valid: number; null: number; failed: number }>> = {};
let allNullRows = 0, unknownRows = 0;
for (const row of matrix) for (const code of row.codes) {
  const values = HISTORY_FIELDS.map(field => {
    const stat = ((perBondStats[code] ??= {})[field] ??= { requested: 0, valid: 0, null: 0, failed: 0 });
    stat.requested++;
    const key = observationKey(code, row.date, field);
    if (!cells.has(key)) {stat.failed++; return undefined;}
    const value = cells.get(key)!;
    if (value === null) stat.null++; else stat.valid++;
    return value;
  });
  if (values.every(value => value === null)) allNullRows++;
  if (values.some(value => value === undefined)) unknownRows++;
}
const excluded = { beforeIssue: 0, afterMaturity: 0 };
for (const date of dates) for (const bond of bonds) {
  if (bond.issue_date > date) excluded.beforeIssue++;
  else if (bond.maturity_date && bond.maturity_date < date) excluded.afterMaturity++;
}
const expectedBytes = JSON.stringify(rows);
const ready = { unweighted: rows.filter(r => r.chinabond_yield_pct !== null && r.remaining_term_years !== null
  && r.remaining_term_years > 0).length,
weighted: rows.filter(r => r.chinabond_yield_pct !== null && r.remaining_term_years !== null && r.remaining_term_years > 0
  && r.outstanding_balance_cny !== null && r.outstanding_balance_cny > 0).length };
const validationEvidence = [];
for (const file of ['balance-validation-plan.json', 'balance-2019-01-21.json', 'balance-2022-01-17.json',
  'boundary-validation-plan.json', 'boundary-existing.json', 'boundary-validation.json',
  'quota-before-validation.json', 'quota-before-collection.json',
  'field-docs/103001024001.md', 'field-docs/103001001001.md']) {
  validationEvidence.push({ file, sha256: hash(await read(file)) });
}
const manifest = { assembledAt: new Date().toISOString(), planSha256: hash(planBytes),
  matrixSha256: hash(matrixBytes), beforeSha256: hash(beforeBytes), expectedRowsSha256: hash(expectedBytes),
  scope: plan.scope, units: plan.units, historicalVintageVerified: false, availableAt: null,
  observationDatesAreHistorical: true, quotationCaptureTime: 'see each source capturedAt',
  allNullRowsNotInserted: allNullRows, unknownRows, excluded,
  rows: rows.length, uniqueBonds: new Set(rows.map(r => r.bond_code)).size, ready, stats, perBondStats, failures, sources, validationEvidence };
if (action === '--apply') {
  const reviewedBytes = await read('bond-history-manifest.json');
  // Only the assembly clock can differ; all matrix, values and source identities must match review.
  verifyHistoricalReview(manifest, expectedBytes, reviewedBytes, await read('expected-rows.json'), reviewedManifestSha!, reviewedRowsSha!);
} else {
  await writeFile(path.join(directory, 'expected-rows.json'), expectedBytes);
  await writeFile(path.join(directory, 'bond-history-manifest.json'), JSON.stringify(manifest, null, 2));
}
console.log(JSON.stringify({ dryRun: action !== '--apply', rows: rows.length, ready, stats, failures: failures.length }));
if (action === '--apply') {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    const result = await insertHistoricalBonds(db, rows, matrix);
    await writeFile(path.join(directory, 'bond-history-application.json'), JSON.stringify({ appliedAt: new Date().toISOString(),
      planSha256: hash(planBytes), manifestSha256: reviewedManifestSha, expectedRowsSha256: hash(expectedBytes), ...result }, null, 2));
    console.log(JSON.stringify({ committed: true, ...result }));
  } finally { await db.end(); }
}
