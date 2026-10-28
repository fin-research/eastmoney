import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BROKER_CURVE_PROFILE as p, HISTORY_TENORS, parseHistoricalDay,
  planHistoricalRepair, applyHistoricalRepair, parseHistoricalSeries, validateHistoryMatrix, type StoredNode } from '../src/sync/broker-curve-history.ts';
const date = '2020-12-28';
const payload = [{ ycDefId: p.curveCode, ycDefName: `${p.curveName}(到期)`, worktime: date,
  seriesData: HISTORY_TENORS.map(t => [t, t < 1 ? 2.4 : 3 + t / 10]) }];
const incoming = () => parseHistoricalDay(payload, date);
const legacy = (): StoredNode => ({ curve_code: p.curveCode, curve_name: p.curveName,
  date, tenor_years: 7 / 365, yield_pct: 3.7, node_label: '7d' });
const long = (): StoredNode => ({ ...legacy(), tenor_years: 7, node_label: '7y' });
it('takes tenor years from the official daily numbers and rejects mismatched/missing evidence', () => {
  expect(incoming()[0]).toMatchObject({ tenor_years: 0.019178, yield_pct: 2.4 });
  expect(p.preLaunchObservations).toBe('retrospective_simulation');
  expect(p.pointAvailableAt).toBeNull();
  expect(() => parseHistoricalDay(payload, '2019-01-02')).toThrow('identity/date');
  expect(() => parseHistoricalDay([{ ...payload[0], ycDefName: '中债企业债收益率曲线(AAA)' }], date)).toThrow('identity');
  expect(() => parseHistoricalDay([{ ...payload[0], seriesData: [[7, 3.7]] }], date)).toThrow('unavailable');
});
it('requires same-day long-copy evidence and exact legacy label instead of deleting all short nodes', () => {
  const plan = planHistoricalRepair(incoming(), [legacy(), long()]);
  expect(plan.conflicts).toEqual([]);
  expect(plan.deletes).toEqual([legacy()]);
  expect(plan.inserts).toHaveLength(16);
  expect(planHistoricalRepair(incoming(), [{ ...legacy(), yield_pct: 3.8 }]).conflicts).toHaveLength(1);
  expect(planHistoricalRepair(incoming(), [{ ...legacy(), node_label: 'unknown' }]).conflicts).toHaveLength(1);
  expect(planHistoricalRepair(incoming(), [{ ...legacy(), date: '2020-12-29' }]).conflicts).toHaveLength(1);
});
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE bond_industry_curve(curve_code text,curve_name text,observation_date date,
    tenor_years double precision,yield_pct double precision,node_label text,
    PRIMARY KEY(curve_code,observation_date,tenor_years));`);
  const old = legacy();
  await db.query('INSERT INTO bond_industry_curve VALUES($1,$2,$3,$4,$5,$6)',
    [old.curve_code, old.curve_name, old.date, old.tenor_years, old.yield_pct, old.node_label]);
  const normal = long();
  await db.query('INSERT INTO bond_industry_curve VALUES($1,$2,$3,$4,$5,$6)',
    [normal.curve_code, normal.curve_name, normal.date, normal.tenor_years, normal.yield_pct, normal.node_label]);
  // Adapt pg rowCount only; execute the real repair SQL and transaction in Postgres.
  return { db, client: { query: async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values); return { rows: result.rows, rowCount: result.affectedRows };
  } } };
}
it('atomically replaces proven aliases and becomes a no-op against a fresh after-image', async () => {
  const { db, client } = await database();
  try {
    expect(await applyHistoricalRepair(client as never, planHistoricalRepair(incoming(), [legacy(), long()])))
      .toEqual({ inserted: 16, deleted: 1 });
    const after = (await db.query<StoredNode>(`SELECT curve_code,curve_name,observation_date::text AS date,
      tenor_years,yield_pct,node_label FROM bond_industry_curve`)).rows;
    const repeat = planHistoricalRepair(incoming(), after);
    expect(repeat).toMatchObject({ inserts: [], deletes: [], conflicts: [] });
  } finally { await db.close(); }
});
it('rolls back deletions when canonical keys changed and rejects modified before-images', async () => {
  const { db, client } = await database();
  const plan = planHistoricalRepair(incoming(), [legacy(), long()]);
  try {
    await db.query('INSERT INTO bond_industry_curve VALUES($1,$2,$3,$4,$5,$6)',
      [p.curveCode, p.curveName, date, 0.019178, 2.4, '0.019178y']);
    await expect(applyHistoricalRepair(client as never, plan)).rejects.toThrow('Canonical key changed');
    expect((await db.query('SELECT * FROM bond_industry_curve')).rows).toHaveLength(3);
    await db.query("UPDATE bond_industry_curve SET yield_pct=4 WHERE node_label='7d'");
    await expect(applyHistoricalRepair(client as never, plan)).rejects.toThrow('before-image changed');
    expect((await db.query('SELECT * FROM bond_industry_curve')).rows).toHaveLength(3);
  } finally { await db.close(); }
});

it('checks historical tenor identities and keeps the two endpoint values separate', () => {
  const series = [{ ycDefId: p.curveCode + '3.0', ycDefName: p.curveName + '(到期)(3y)',
    seriesData: [[Date.parse('2019-01-02T00:00:00+08:00'), 3.7672]] }];
  expect(parseHistoricalSeries(series, [3], '2019-01-01', '2020-12-31')[0])
    .toMatchObject({ date: '2019-01-02', tenor_years: 3, yield_pct: 3.7672 });
  expect(() => parseHistoricalSeries(series, [7 / 365], '2019-01-01', '2020-12-31')).toThrow('tenor');
  expect(() => parseHistoricalSeries(series, [3], '2020-01-01', '2020-12-31')).toThrow('date');
});

it('rejects whole-day omissions and different dates across historical tenor batches', () => {
  const dates = ['2019-01-02', '2019-01-03'];
  const matrix = dates.flatMap(date => [1, 2].map(tenor_years => ({date, tenor_years, yield_pct:3,node_label:'x'})));
  expect(() => validateHistoryMatrix(matrix, dates, [1,2])).not.toThrow();
  expect(() => validateHistoryMatrix(matrix.filter(r=>r.date!==dates[1]), dates, [1,2])).toThrow('Incomplete');
  expect(() => validateHistoryMatrix(matrix.map(r=>r.tenor_years===2?{...r,date:'2019-01-04'}:r), dates,[1,2]))
    .toThrow('Unexpected');
});
it('locks and checks retained canonical before-images before deleting an alias', async () => {
  const {db, client} = await database();
  try {
    const correct: StoredNode = {...legacy(),tenor_years:0.019178,yield_pct:2.4,node_label:'0.019178y'};
    await db.query('INSERT INTO bond_industry_curve VALUES($1,$2,$3,$4,$5,$6)',
      [correct.curve_code,correct.curve_name,correct.date,correct.tenor_years,correct.yield_pct,correct.node_label]);
    const plan = planHistoricalRepair(incoming(),[legacy(),long(),correct]);
    await db.query('UPDATE bond_industry_curve SET yield_pct=9 WHERE tenor_years=0.019178');
    await expect(applyHistoricalRepair(client as never,plan)).rejects.toThrow('Retained canonical before-image changed');
    expect((await db.query('SELECT * FROM bond_industry_curve')).rows).toHaveLength(3);
  } finally {await db.close();}
});
