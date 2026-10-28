import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { syncBrokerCurve } from '../src/sync/broker-curve-sync.ts';

const code = '5781a1ff7651967e0176978d957b7346';
const nodes = [0.25, 0.5, 1, 2, 3, 5, 10].map(tenorYears => ({ tenorYears, yieldPct: 2 }));
const earlyDates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
  '2026-09-18', '2026-09-21', '2026-09-22'];

async function database(dates: string[]) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE bond_industry_curve(curve_code text,curve_name text,observation_date date,
    tenor_years double precision,yield_pct double precision,node_label text,
    PRIMARY KEY(curve_code,observation_date,tenor_years));`);
  for (const date of dates) {
    await db.query(`INSERT INTO bond_industry_curve
      SELECT $1,'original',$2::date,t,2,'original' FROM unnest($3::float8[]) t`,
    [code, date, nodes.map(node => node.tenorYears)]);
  }
  const client = { query: async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows };
  } };
  return { db, client: client as never };
}

it('rechecks an empty interior date after later dates succeed, completing partial nodes without changing complete dates', async () => {
  const { db, client } = await database(earlyDates);
  try {
    await db.query(`INSERT INTO bond_industry_curve VALUES($1,'partial','2026-09-23',3,1.5,'3y')`, [code]);
    const original = (await db.query(`SELECT * FROM bond_industry_curve WHERE curve_name='original'
      ORDER BY observation_date,tenor_years`)).rows;
    const first = vi.fn(async (date: string) => date === '2026-09-23' ? null : nodes);
    expect(await syncBrokerCurve(client, '2026-09-26', first))
      .toEqual({ stored: 14, missingDates: ['2026-09-23'], failures: [] });
    expect(first.mock.calls.map(([date]) => date)).toEqual(['2026-09-23', '2026-09-24', '2026-09-25']);
    const recover = vi.fn(async (_date: string) => nodes);
    expect(await syncBrokerCurve(client, '2026-09-27', recover))
      .toEqual({ stored: 7, missingDates: [], failures: [] });
    expect(recover.mock.calls.map(([date]) => date)).toEqual(['2026-09-23']);
    expect((await db.query(`SELECT * FROM bond_industry_curve WHERE curve_name='original'
      ORDER BY observation_date,tenor_years`)).rows).toEqual(original);
    expect((await db.query(`SELECT tenor_years,yield_pct FROM bond_industry_curve
      WHERE observation_date='2026-09-23' ORDER BY tenor_years`)).rows)
      .toEqual(nodes.map(node => ({ tenor_years: node.tenorYears, yield_pct: node.yieldPct })));
    recover.mockClear();
    expect(await syncBrokerCurve(client, '2026-09-27', recover))
      .toEqual({ stored: 0, missingDates: [], failures: [] });
    expect(recover).not.toHaveBeenCalled();
  } finally { await db.close(); }
});

it('reports only uncompleted candidates after an error and does not request complete dates', async () => {
  const { db, client } = await database([...earlyDates, '2026-09-24', '2026-09-25']);
  try {
    const load = vi.fn(async (_date: string) => { throw new Error('Mismatched curve'); });
    expect(await syncBrokerCurve(client, '2026-09-29', load)).toEqual({ stored: 0,
      missingDates: ['2026-09-23', '2026-09-28'],
      failures: [{ source: 'broker-curve', error: '2026-09-23: Mismatched curve' }] });
    expect(load.mock.calls.map(([date]) => date)).toEqual(['2026-09-23']);
  } finally { await db.close(); }
});

it('includes target minus thirteen days, leaves older holes alone, and keeps the tail-gap stop', async () => {
  const { db, client } = await database(['2026-09-11', '2026-09-28']);
  try {
    const load = vi.fn(async (_date: string) => null);
    const result = await syncBrokerCurve(client, '2026-09-29', load);
    expect(load.mock.calls.map(([date]) => date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17',
      '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
    expect(result.missingDates).toEqual(load.mock.calls.map(([date]) => date));
    load.mockClear();
    await expect(syncBrokerCurve(client, '2026-10-14', load)).rejects.toThrow('gap exceeds 14 days');
    expect(load).not.toHaveBeenCalled();
  } finally { await db.close(); }
});

it('bootstraps only the target date when no complete history exists', async () => {
  const { db, client } = await database([]);
  try {
    const load = vi.fn(async (_date: string) => nodes);
    expect(await syncBrokerCurve(client, '2026-09-29', load))
      .toEqual({ stored: 7, missingDates: [], failures: [] });
    expect(load.mock.calls.map(([date]) => date)).toEqual(['2026-09-28']);
  } finally { await db.close(); }
});
