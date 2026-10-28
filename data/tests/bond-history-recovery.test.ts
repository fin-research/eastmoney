import { expect, it, vi } from 'vitest';
import { syncBondHistory } from '../src/sync/bond-history-sync.ts';
import type { DatabaseClient } from '../src/sync/postgres.ts';

const quota = { function: 'DATASTATISTICS', rows: [{ FUNCENAME: 'EM_CSS', SECUTYPE: '全品种',
  PERIOD: 'W', STARTDATE: '2026-10-19', ENDDATE: '2026-10-25', AVAILABEDATA: 1000000 }] };

function database() {
  let first = true;
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('WITH dates AS') && first) {
      first = false;
      return { rows: ['2026-10-20', '2026-10-19', '2026-10-16'].map(date => ({ date, code: '123456.SH' })) };
    }
    return { rows: [], rowCount: sql.startsWith('INSERT') ? 1 : 0 };
  });
  return { query, db: <T>(operation: (client: DatabaseClient) => Promise<T>) => operation({ query } as unknown as DatabaseClient) };
}

it('records an isolated service failure and continues independent dates', async () => {
  const { query, db } = database();
  let paid = 0;
  const result = await syncBondHistory(async path => {
    if (path.endsWith('data-statistics')) return quota;
    if (++paid === 1) throw new Error('10000013 service error');
    return { function: 'CSS', rows: [{ code: '123456.SH', YIELDCNBD: 1.6, BONDBALANCE: 100, MATUCNBD: 3 }] };
  }, db, '2026-10-21', ['2026-10-16','2026-10-19','2026-10-20']);
  expect(paid).toBe(3);
  expect(result.stored).toBe(2);
  expect(JSON.parse(result.failures[0]!.error)).toMatchObject({ date: '2026-10-20', codes: ['123456.SH'] });
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE public.bond_issuance'))).toBe(false);
});

it('stops on consecutive service failures and immediately on permission/unknown failures', async () => {
  for (const [message, expected] of [['10000013 service error', 2], ['10001003 permission', 1], ['network failed', 1]] as const) {
    const { db } = database(); let paid = 0;
    const result = await syncBondHistory(async path => {
      if (path.endsWith('data-statistics')) return quota;
      paid++; throw new Error(message);
    }, db, '2026-10-21', ['2026-10-16','2026-10-19','2026-10-20']);
    expect(paid).toBe(expected);
    expect(result.stored).toBe(0);
    expect(result.failures).toHaveLength(expected);
  }
});

it('never writes successful all-NULL quotes as observations', async () => {
  const { query, db } = database();
  const result = await syncBondHistory(async path => path.endsWith('data-statistics') ? quota
    : { function: 'CSS', rows: [{ code: '123456.SH', YIELDCNBD: null, BONDBALANCE: null, MATUCNBD: null }] }, db, '2026-10-21', ['2026-10-16','2026-10-19','2026-10-20']);
  expect(result.stored).toBe(0);
  expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});

it('does not issue CSS or retry after an unavailable quota report', async () => {
  vi.useFakeTimers();
  try {
    const { db } = database();
    const request = vi.fn(async (path: string) => {
      expect(path).toBe('/choice/data-statistics');
      throw new Error('10000009 no data');
    });
    const pending = syncBondHistory(request, db, '2026-10-21', ['2026-10-16','2026-10-19','2026-10-20']);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.failures[0]).toMatchObject({ kind:'execution',error:expect.stringContaining('10000009') });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('retains the quota failure when later read-only coverage queries fail', async () => {
  let first = true;
  const query = vi.fn(async () => {
    if (first) { first = false; return { rows: [{ date:'2026-10-20',code:'123456.SH' }] }; }
    throw new Error('coverage unavailable');
  });
  const request = vi.fn(async () => ({ function:'DATASTATISTICS',rows:[] }));
  const result = await syncBondHistory(request,
    async operation => operation({query} as unknown as DatabaseClient), '2026-10-21',['2026-10-20']);
  expect(request.mock.calls).toHaveLength(1);
  expect(result.failures[0]).toMatchObject({source:'bond-history',kind:'execution',error:expect.stringContaining('quota unavailable')});
  expect(result.failures.filter(failure => failure.source==='bond-history-coverage')).toHaveLength(4);
});
