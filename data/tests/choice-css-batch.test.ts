import { expect, it, vi } from 'vitest';
import { cssIsolationPoints, syncChoiceCssBatch } from '../src/sync/choice-css-batch.ts';
import { EconomicIndicatorRequestError } from '../src/sync/economic-indicator-request.ts';

it('budgets all split requests and stops immediately on quota or permission failures', async () => {
  const requests: string[][] = [];
  const excluded: string[] = [];
  await syncChoiceCssBatch(async (_path, params) => {
    const codes = params.get('codes')!.split(','); requests.push(codes);
    throw new EconomicIndicatorRequestError({path:'/choice/css',parameters:Object.fromEntries(params),stage:'http_response',
      responseBody:JSON.stringify({error:{upstreamCode:10003008}})});
  }, ['A','B','C'], ['X','Y'], '', async () => {}, async code => { excluded.push(code); });
  expect(excluded).toEqual(['A','B','C']);
  expect(requests).toHaveLength(5);
  expect(requests.reduce((sum, codes) => sum + codes.length * 2, 0)).toBeLessThanOrEqual(cssIsolationPoints(3,2,100));
  const request = vi.fn(async () => { throw new Error('10001003 permission denied'); });
  await expect(syncChoiceCssBatch(request,['A','B'],['X'],'',async () => {},async () => {})).rejects.toThrow('permission denied');
  expect(request).toHaveBeenCalledOnce();
});
