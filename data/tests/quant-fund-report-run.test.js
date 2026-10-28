import { test, expect, vi } from 'vitest';
import { runFundReportSync, runFundReportWindowSync } from '../src/sync/quant-fund-report-run.ts';

function fixture() {
  const html = `<html>证券公司资金日报 20260916
    截至上一交易日我司两融规模 <b>100.12 亿</b><script>
    mk('gLcr').setOption(gaugeOpt('LCR',150,1000,130,CYAN,'140'));
    mk('gNsfr').setOption(gaugeOpt('NSFR',160,300,130,GOLD,'150'));
    var terms=['1D','1M'];var gaps=[1,-20];</script></html>`;
  const bucket = {
    list: vi.fn(() => { throw new Error('Must never scan reports'); }),
    get: vi.fn(async () => ({ etag: 'current', size: html.length, text: async () => html })),
  };
  const client = { query: vi.fn(async (sql) => ({ rows: [], rowCount: sql.startsWith('INSERT INTO public.quant_input\n') ? 4 : 0 })) };
  const db = (operation) => operation(client);
  const step = { do: async (_name, operation) => operation() };
  return { bucket, client, db, step };
}

test('reads exactly the current date directly, without listing or querying historical metadata', async () => {
  const h = fixture();
  expect(await runFundReportSync(h.bucket, h.db, '2026-09-16')).toEqual({ stored: 4, failures: [] });
  expect(h.bucket.get).toHaveBeenCalledExactlyOnceWith('fund-reports/2026-09-16.html');
  expect(h.bucket.list).not.toHaveBeenCalled();
  expect(h.client.query.mock.calls.some(([sql]) => sql.startsWith('SELECT'))).toBe(false);
});

test('missing current-day report is skipped without database writes or fallback reads', async () => {
  const h = fixture(); h.bucket.get.mockResolvedValue(null);
  expect(await runFundReportSync(h.bucket, h.db, '2026-09-16')).toEqual({ stored: 0, failures: [], missing: [{ source: 'fund-reports/2026-09-16.html', dates: ['2026-09-16'], reason: 'report_not_uploaded' }] });
  expect(h.bucket.get).toHaveBeenCalledTimes(1);
  expect(h.bucket.list).not.toHaveBeenCalled();
  expect(h.client.query).not.toHaveBeenCalled();
});

test('database failure is surfaced to the enclosing business step', async () => {
  const h = fixture();
  h.client.query.mockRejectedValueOnce(new Error('temporary database error'));
  await expect(runFundReportSync(h.bucket, h.db, '2026-09-16')).rejects.toThrow('temporary database error');
  expect(h.bucket.get).toHaveBeenCalledTimes(1);
});


test('completed trading-day window collects late uploads and applies same-date corrections', async () => {
  const h = fixture();
  h.bucket.get.mockImplementation(async key => key.endsWith('2026-09-16.html') ? {
    size: 1000, text: async () => `证券公司资金日报 20260916 截至上一交易日我司两融规模 100 亿<script>
      mk('gLcr').setOption(gaugeOpt('LCR',170,1000,130));
      mk('gNsfr').setOption(gaugeOpt('NSFR',180,300,130));
      var terms=['1M'];var gaps=[-30];</script>` } : null);
  const result = await runFundReportWindowSync(h.bucket, h.db, ['2026-09-15','2026-09-16']);
  expect(result.stored).toBe(4);
  expect(result.missing).toEqual([{ source: 'fund-reports/2026-09-15.html', dates: ['2026-09-15'], reason: 'report_not_uploaded' }]);
  expect(h.bucket.get.mock.calls.map(([key]) => key)).toEqual(['fund-reports/2026-09-15.html','fund-reports/2026-09-16.html']);
  const insert = h.client.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO public.quant_input'));
  expect(insert[0]).toContain('DO UPDATE');
  expect(JSON.parse(insert[1][0])).toContainEqual(expect.objectContaining({ field: 'lcr', numericValue: 1.7 }));
  expect(h.bucket.list).not.toHaveBeenCalled();
});

test('one broken historical report does not prevent later reports from being collected', async () => {
  const h = fixture(); h.bucket.get.mockRejectedValueOnce(new Error('R2 unavailable'));
  const result = await runFundReportWindowSync(h.bucket, h.db, ['2026-09-15','2026-09-16']);
  expect(result.stored).toBe(4);
  expect(result.failures).toEqual([{ source: 'fund-reports/2026-09-15.html', error: 'R2 unavailable', kind: 'execution' }]);
});
