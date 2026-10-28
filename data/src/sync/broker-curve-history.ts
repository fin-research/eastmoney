import type { DatabaseClient } from './postgres.ts';
/** Offline verification for controlled ChinaBond history restoration, never a paid Choice call. */
export const BROKER_CURVE_PROFILE = {
  curveCode: '5781a1ff7651967e0176978d957b7346',
  curveName: '中债证券公司债收益率曲线(AAA)',
  rating: 'AAA', yieldType: '到期', unit: 'percent',
  reportedFirstPublicationDate: '2020-12-28',
  publicationEvidence: 'https://www.sohu.com/a/439052386_221675',
  publicationEvidenceType: 'reproduced announcement; original publisher page not yet located',
  preLaunchObservations: 'retrospective_simulation',
  historicalVintageVerified: false,
  // A launch date does not establish when each presently returned vintage was available.
  pointAvailableAt: null,
} as const;
export const HISTORY_TENORS = [0.019178, 0.038356, 0.083333, 0.166667, 0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const aliases = new Map([[7 / 365, { tenor: 0.019178, copiedFrom: 7, label: '7d' }],
  [1 / 12, { tenor: 0.083333, copiedFrom: 1, label: '1m' }],
  [2 / 12, { tenor: 0.166667, copiedFrom: 2, label: '2m' }]]);
export type HistoryNode = { date: string; tenor_years: number; yield_pct: number; node_label: string };
export type StoredNode = HistoryNode & { curve_code: string; curve_name: string };
export function validateHistoryMatrix(rows: HistoryNode[], dates: string[], tenors: readonly number[]) {
  const expected = new Set(dates.flatMap(date => tenors.map(tenor => `${date}/${tenor}`)));
  for (const row of rows) {
    if (!expected.delete(`${row.date}/${row.tenor_years}`)) throw Error('Unexpected/duplicate history matrix cell');
  }
  if (expected.size) throw Error(`Incomplete history matrix: ${expected.size} cells`);
}
export function parseHistoricalSeries(payload: unknown, tenors: number[], first: string, last: string): HistoryNode[] {
  if (!Array.isArray(payload) || payload.length !== tenors.length) throw Error('Incomplete historical series');
  const found = new Set<number>(), rows: HistoryNode[] = [];
  let expectedDates: string | undefined;
  for (const series of payload) {
    if (typeof series.ycDefId !== 'string' || !series.ycDefId.startsWith(BROKER_CURVE_PROFILE.curveCode)
      || typeof series.ycDefName !== 'string' || !series.ycDefName.startsWith(`${BROKER_CURVE_PROFILE.curveName}(到期)`)
      || !Array.isArray(series.seriesData) || !series.seriesData.length) throw Error('Invalid historical identity');
    const tenor = Number(series.ycDefId.slice(BROKER_CURVE_PROFILE.curveCode.length));
    if (!tenors.includes(tenor) || found.has(tenor)) throw Error('Wrong/duplicate historical tenor');
    found.add(tenor);
    const dates = new Set<string>();
    for (const pair of series.seriesData) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0])
        || typeof pair[1] !== 'number' || !Number.isFinite(pair[1]) || pair[1] <= 0 || pair[1] >= 20) throw Error('Invalid history point');
      const date = new Date(pair[0] + 8 * 3600000).toISOString().slice(0, 10);
      if (date < first || date > last || dates.has(date)) throw Error('Historical date mismatch');
      dates.add(date);
      rows.push({ date, tenor_years: tenor, yield_pct: pair[1], node_label: `${tenor}y` });
    }
    const grid = [...dates].sort().join(',');
    if (expectedDates !== undefined && grid !== expectedDates) throw Error('Historical tenor dates differ');
    expectedDates = grid;
  }
  return rows;
}
export function parseHistoricalDay(payload: unknown, date: string): HistoryNode[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(payload) || payload.length !== 1) throw Error('Missing official day');
  const series = payload[0];
  if (series.ycDefId !== BROKER_CURVE_PROFILE.curveCode || series.ycDefName !== `${BROKER_CURVE_PROFILE.curveName}(到期)`
    || series.worktime !== date || !Array.isArray(series.seriesData)) throw Error('Curve identity/date mismatch');
  const values = new Map<number, number>();
  for (const point of series.seriesData) {
    if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number'
      || !Number.isFinite(point[0]) || point[0] < 0 || !Number.isFinite(point[1]) || point[1] <= 0 || point[1] >= 20
      || values.has(point[0])) throw Error('Invalid/duplicate official node');
    values.set(point[0], point[1]);
  }
  return HISTORY_TENORS.map(tenor => {
    if (!values.has(tenor)) throw Error(`Official tenor unavailable: ${date}/${tenor}`);
    return { date, tenor_years: tenor, yield_pct: values.get(tenor)!, node_label: `${tenor}y` };
  });
}
/** Preserve existing normal nodes; remove only proven legacy copy errors with exact before-images. */
export function planHistoricalRepair(incoming: HistoryNode[], existing: StoredNode[]) {
  const key = (r: HistoryNode) => `${r.date}/${r.tenor_years}`;
  const observed = new Map<string, HistoryNode>();
  for (const row of incoming) {
    if (observed.has(key(row))) throw Error('Duplicate incoming history');
    observed.set(key(row), row);
  }
  const stored = new Map(existing.map(row => [key(row), row]));
  const inserts = incoming.filter(row => !stored.has(key(row)));
  const retained = existing.filter(row => observed.has(key(row)));
  const deletes: StoredNode[] = [];
  const conflicts: string[] = [];
  for (const row of existing) {
    const official = observed.get(key(row));
    if (official && (row.yield_pct !== official.yield_pct || row.curve_name !== BROKER_CURVE_PROFILE.curveName)) {
      conflicts.push(`Existing canonical value differs: ${key(row)}`);
    }
    const alias = aliases.get(row.tenor_years);
    if (!alias) continue;
    const correct = observed.get(`${row.date}/${alias.tenor}`);
    if (!correct) { conflicts.push(`No same-day short-node evidence: ${key(row)}`); continue; }
    // The frozen long node preserves the old queryYz vintage. Today's daily endpoint can differ by 0.0001pp.
    const copied = stored.get(`${row.date}/${alias.copiedFrom}`);
    if (row.curve_code !== BROKER_CURVE_PROFILE.curveCode || row.curve_name !== BROKER_CURVE_PROFILE.curveName
      || row.node_label !== alias.label || row.yield_pct !== copied?.yield_pct) {
      conflicts.push(`Legacy before-image not proven: ${key(row)}`); continue;
    }
    deletes.push(row);
  }
  return { inserts, deletes, retained, conflicts };
}

export async function applyHistoricalRepair(db: DatabaseClient, plan: ReturnType<typeof planHistoricalRepair>) {
  if (plan.conflicts.length) throw Error('Repair conflicts');
  await db.query('BEGIN');
  try {
    const retained = await db.query(`SELECT c.curve_code FROM public.bond_industry_curve c JOIN
      jsonb_to_recordset($1::jsonb) x(curve_code text,curve_name text,date date,
        tenor_years double precision,yield_pct double precision,node_label text)
      ON c.curve_code=x.curve_code AND c.observation_date=x.date AND c.tenor_years=x.tenor_years
      WHERE c.curve_name=x.curve_name AND c.yield_pct=x.yield_pct
        AND c.node_label IS NOT DISTINCT FROM x.node_label FOR UPDATE OF c`, [JSON.stringify(plan.retained)]);
    if (retained.rows.length !== plan.retained.length) throw Error('Retained canonical before-image changed; rollback');
    const removed = await db.query(`DELETE FROM public.bond_industry_curve c USING
      jsonb_to_recordset($1::jsonb) x(curve_code text,curve_name text,date date,
        tenor_years double precision,yield_pct double precision,node_label text)
      WHERE c.curve_code=x.curve_code AND c.curve_name=x.curve_name AND c.observation_date=x.date
        AND c.tenor_years=x.tenor_years AND c.yield_pct=x.yield_pct AND c.node_label IS NOT DISTINCT FROM x.node_label`,
    [JSON.stringify(plan.deletes)]);
    if (removed.rowCount !== plan.deletes.length) throw Error('Legacy before-image changed; rollback');
    const inserted = await db.query(`INSERT INTO public.bond_industry_curve
      (curve_code,curve_name,observation_date,tenor_years,yield_pct,node_label)
      SELECT $1,$2,x.date,x.tenor_years,x.yield_pct,x.node_label FROM jsonb_to_recordset($3::jsonb)
        x(date date,tenor_years double precision,yield_pct double precision,node_label text)
      ON CONFLICT (curve_code,observation_date,tenor_years) DO NOTHING`,
    [BROKER_CURVE_PROFILE.curveCode, BROKER_CURVE_PROFILE.curveName, JSON.stringify(plan.inserts)]);
    if (inserted.rowCount !== plan.inserts.length) throw Error('Canonical key changed; rollback');
    await db.query('COMMIT');
    return { inserted: inserted.rowCount, deleted: removed.rowCount };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}
