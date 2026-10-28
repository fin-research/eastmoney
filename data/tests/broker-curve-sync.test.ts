import { describe, expect, it, vi } from 'vitest';
import { fetchBrokerCurve, syncBrokerCurve } from '../src/sync/broker-curve-sync.ts';

const nodes: Array<[number, number]> = [
  [0.25, 1.47], [0.5, 1.49], [1, 1.51], [2, 1.56], [3, 1.6208], [5, 1.75], [10, 2.05],
];
const curve = (date: string, data: unknown[] = [[0, 1.4866], ...nodes]) => [{
  ycDefId: '5781a1ff7651967e0176978d957b7346',
  ycDefName: '中债证券公司债收益率曲线(AAA)(到期)',
  worktime: date,
  seriesData: data,
}];

describe('official broker AAA tenor curve sync', () => {
  it('accepts the exact official curve and date, including an empty holiday response', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.method).toBe('POST');
      expect(new URLSearchParams(init.body).get('workTimes')).toBe('2026-09-24');
      return new Response(JSON.stringify(curve('2026-09-24')), { status: 200 });
    });
    expect(await fetchBrokerCurve('2026-09-24', fetcher as typeof fetch)).toEqual(
      nodes.map(([tenorYears, yieldPct]) => ({ tenorYears, yieldPct })),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await fetchBrokerCurve('2026-09-25', async () => new Response('[]') as Response)).toBeNull();
    await expect(fetchBrokerCurve('2026-09-24', async () =>
      new Response(JSON.stringify(curve('2026-09-23'))) as Response)).rejects.toThrow('Mismatched');
    await expect(fetchBrokerCurve('2026-09-24', async () =>
      new Response(JSON.stringify(curve('2026-09-24', [[2, 1.6]]))) as Response)).rejects.toThrow('Incomplete');
    await expect(fetchBrokerCurve('2026-09-24', async () =>
      new Response(JSON.stringify(curve('2026-09-24', [...nodes, [3, 1.7]]))) as Response))
      .rejects.toThrow('Duplicate');
  });

  it('fills dates with only a 3Y node and replays missing weekdays into observation columns', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return sql.startsWith('SELECT')
        ? { rows: [{ latest_date: '2026-09-22', complete_dates: [
          '2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-22',
        ] }], rowCount: 1 }
        : { rows: [], rowCount: 7 };
    }) };
    const load = vi.fn(async (date: string) => date === '2026-09-25' ? null
      : nodes.map(([tenorYears, yieldPct]) => ({ tenorYears, yieldPct })));
    const result = await syncBrokerCurve(client as never, '2026-09-29', load);
    expect(load.mock.calls.map(([date]) => date)).toEqual([
      '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28',
    ]);
    expect(result).toEqual({ stored: 21, missingDates: ['2026-09-25'], failures: [] });
    expect(queries[1]?.sql).toContain('ON CONFLICT (curve_code,observation_date,tenor_years)');
    expect(queries[1]?.sql).not.toContain('source_snapshot_at');
    expect(queries[0]?.sql).toContain('HAVING count(*) FILTER');
    const rows = queries.slice(1).flatMap(query => JSON.parse(query.params[2] as string));
    expect(rows).toHaveLength(21);
    expect(rows.filter((row: { tenor_years: number }) => row.tenor_years === 3)).toEqual([
      { date: '2026-09-23', tenor_years: 3, yield_pct: 1.6208, node_label: '3y' },
      { date: '2026-09-24', tenor_years: 3, yield_pct: 1.6208, node_label: '3y' },
      { date: '2026-09-28', tenor_years: 3, yield_pct: 1.6208, node_label: '3y' },
    ]);
  });

  it('persists completed dates before a timeout, retries once, and resumes from the remaining gap', async () => {
    let latest = '2026-09-22';
    const complete = ['2026-09-14','2026-09-15','2026-09-16','2026-09-17',
      '2026-09-18','2026-09-21','2026-09-22'];
    const storedDates: string[] = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rows: [{ latest_date: latest, complete_dates: complete }], rowCount: 1 };
      const rows = JSON.parse(params[2] as string);
      latest = rows[0].date; storedDates.push(latest); complete.push(latest);
      return { rows: [], rowCount: rows.length };
    }) };
    const load = vi.fn(async (date: string) => {
      if (date === '2026-09-24') throw new DOMException('timed out', 'TimeoutError');
      return nodes.map(([tenorYears, yieldPct]) => ({ tenorYears, yieldPct }));
    });
    const failed = await syncBrokerCurve(client as never, '2026-09-26', load);
    expect(storedDates).toEqual(['2026-09-23']);
    expect(load.mock.calls.map(([date]) => date)).toEqual(['2026-09-23','2026-09-24','2026-09-24']);
    expect(failed).toEqual({ stored: 7, missingDates: ['2026-09-24','2026-09-25'],
      failures: [{source:'broker-curve',error:'2026-09-24: timed out'}] });
    const resume = vi.fn(async (_date: string) => nodes.map(([tenorYears, yieldPct]) => ({ tenorYears, yieldPct })));
    expect(await syncBrokerCurve(client as never, '2026-09-26', resume)).toEqual({ stored:14,missingDates:[],failures:[] });
    expect(resume.mock.calls.map(([date]) => date)).toEqual(['2026-09-24','2026-09-25']);
  });
});
