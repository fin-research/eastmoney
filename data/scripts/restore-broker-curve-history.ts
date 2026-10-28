/** Offline, bounded repair from captured official searchYc days. Never fetches upstream. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { BROKER_CURVE_PROFILE, parseHistoricalDay, planHistoricalRepair, applyHistoricalRepair, parseHistoricalSeries, validateHistoryMatrix,
  type StoredNode, type HistoryNode } from '../src/sync/broker-curve-history.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const directory = args[args.indexOf('--cache-dir') + 1];
if (!args.includes('--cache-dir') || !directory || args.some((a, i) =>
  a !== '--apply' && a !== '--cache-dir' && args[i - 1] !== '--cache-dir')) {
  throw Error('Usage: restore-broker-curve-history.ts --cache-dir DIR [--apply]');
}
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const dates: string[] = JSON.parse(await readFile(path.join(directory, 'dates.json'), 'utf8'));
if (!dates.length || dates.length > 2500 || new Set(dates).size !== dates.length
  || dates.some(date => date < '2019-01-01' || date > '2026-10-22')) throw Error('Outside controlled repair window');
const beforeBytes = await readFile(path.join(directory, 'before-rows.json'), 'utf8');
const before: StoredNode[] = JSON.parse(beforeBytes);
const nodes: HistoryNode[] = [];
const sources: Array<{ date: string; capturedAt: string; rawSha256: string }> = [];
for (const date of dates) {
  const source = JSON.parse(await readFile(path.join(directory, 'daily', `${date}.json`), 'utf8'));
  if (source.status !== 200 || typeof source.rawBody !== 'string'
    || !Number.isFinite(Date.parse(source.capturedAt)) || source.parameters?.workTimes !== date
    || source.parameters?.ycDefIds !== BROKER_CURVE_PROFILE.curveCode) throw Error(`Unverified source: ${date}`);
  nodes.push(...parseHistoricalDay(JSON.parse(source.rawBody), date).filter(row => row.tenor_years < 0.25));
  sources.push({ date, capturedAt: source.capturedAt, rawSha256: hash(source.rawBody) });
}
const historicalSources = [];
const allHistorical: HistoryNode[] = [];
for (const [batch, tenors] of [[1, [0.25, 0.5, 0.75, 1, 2, 3, 4, 5]], [2, [6, 7, 8, 9, 10]]] as const) {
  const file = `early-history-batch${batch}.json`;
  const bytes = await readFile(path.join(directory, file), 'utf8');
  const source = JSON.parse(bytes);
  if (source.status !== 200 || source.params?.startTime !== '2019-01-01' || source.params?.endTime !== '2020-12-31'
    || !Number.isFinite(Date.parse(source.time))
    || source.params?.ycDefIds !== `${BROKER_CURVE_PROFILE.curveCode},`) throw Error('Unverified historical request');
  const series = parseHistoricalSeries(source.data, [...tenors], '2019-01-01', '2020-12-31');
  allHistorical.push(...series);
  nodes.push(...series.filter(row => row.date < '2020-12-28'));
  historicalSources.push({ file, capturedAt: source.time, archiveSha256: hash(bytes), endpoint: 'queryYz' });
}
validateHistoryMatrix(allHistorical, dates.filter(date => date <= '2020-12-31'),
  [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const earlyDates = dates.filter(date => date < '2020-12-28');
validateHistoryMatrix(nodes.filter(row => row.date < '2020-12-28'), earlyDates,
  [0.019178, 0.038356, 0.083333, 0.166667, 0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
validateHistoryMatrix(nodes.filter(row => row.tenor_years < 0.25), dates, [0.019178, 0.038356, 0.083333, 0.166667]);
const plan = planHistoricalRepair(nodes, before);
const byYear: Record<string, { inserts: number; deletes: number }> = {};
for (const kind of ['inserts', 'deletes'] as const) for (const row of plan[kind]) {
  const year = row.date.slice(0, 4);
  (byYear[year] ??= { inserts: 0, deletes: 0 })[kind]++;
}
const manifest = { createdAt: new Date().toISOString(), profile: BROKER_CURVE_PROFILE,
  sourceUrl: 'https://yield.chinabond.com.cn/cbweb-mn/yc/searchYc', sourceMethod: 'POST',
  beforeSha256: hash(beforeBytes), dates, sources, historicalSources, byYear,
  zeroTenorAnchor: { storedInRawResponses: true, storedInCurveTable: false, reason: 'table requires positive tenor' },
  endpointDifference: '2019–2020 crosscheck: 267/6487 queryYz values exceed searchYc by 0.0001 percentage point; reason unverified; existing normal nodes preserved',
  matrix: { earlyDates: earlyDates.length, earlyTenors: 17, shortDates: dates.length, shortTenors: 4 },
  retainedCount: plan.retained.length, insertCount: plan.inserts.length, deleteCount: plan.deletes.length, conflicts: plan.conflicts,
  planSha256: hash(JSON.stringify(plan)), paidChoiceCalls: 0 };
await writeFile(path.join(directory, 'repair-plan.json'), JSON.stringify(plan));
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ dryRun: !apply, inserts: plan.inserts.length, deletes: plan.deletes.length,
  conflicts: plan.conflicts.length, byYear }));
if (plan.conflicts.length) throw Error(`Repair has conflicts; inspect manifest.json (${plan.conflicts.length})`);
if (apply) {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required for apply');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const result = await applyHistoricalRepair(db, plan);
    await writeFile(path.join(directory, 'application.json'), JSON.stringify({ appliedAt: new Date().toISOString(),
      planSha256: manifest.planSha256, beforeSha256: manifest.beforeSha256,
      ...result, paidChoiceCalls: 0 }, null, 2));
    console.log(JSON.stringify({ committed: true, ...result }));
  } finally { await db.end(); }
}
