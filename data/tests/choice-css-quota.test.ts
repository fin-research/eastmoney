import { expect, it, vi } from 'vitest';
import { requestCssQuota } from '../src/sync/choice-css-quota.ts';
import { requireBondBudget } from '../src/sync/bond-history-sync.ts';
import { EconomicIndicatorRequestError } from '../src/sync/economic-indicator-request.ts';

const unavailable = (upstreamCode: number) => new EconomicIndicatorRequestError({
  path: '/choice/data-statistics', parameters: {}, stage: 'http_response', status: 503,
  responseBody: JSON.stringify({ error: { upstreamCode } }),
});
const quota = { function: 'DATASTATISTICS', rows: [{
  FUNCENAME: 'EM_CSS', SECUTYPE: '全品种', PERIOD: 'W',
  STARTDATE: '2026-10-19', ENDDATE: '2026-10-25', AVAILABEDATA: 110000,
}] };

it('does not retry an unavailable quota report and preserves the shared reserve check', async () => {
  const error = unavailable(10000009);
  const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(quota);
  await expect(requestCssQuota(request)).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.every(([path]) => path === '/choice/data-statistics')).toBe(true);
  expect(() => requireBondBudget(quota, '2026-10-21', 10000)).not.toThrow();
  expect(() => requireBondBudget(quota, '2026-10-21', 10001)).toThrow();
});

it('does not retry permission failures or accept a missing/expired quota', async () => {
  const error = unavailable(10001003);
  const request = vi.fn().mockRejectedValue(error);
  await expect(requestCssQuota(request)).rejects.toBe(error);
  const empty = await requestCssQuota(vi.fn().mockResolvedValue({ function: 'DATASTATISTICS', rows: [] }));
  expect(() => requireBondBudget(empty, '2026-10-21', 1)).toThrow();
  expect(() => requireBondBudget(quota, '2026-10-26', 1)).toThrow();
});
