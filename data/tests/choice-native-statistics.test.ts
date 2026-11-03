import { afterEach, expect, it, vi } from 'vitest';
import { fetchNativeStatistics } from '../src/choice/native/statistics.ts';

afterEach(() => vi.unstubAllGlobals());

it('requests statistics without redirect:error, which workerd rejects, and fails on a redirect', async () => {
  const seen: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    seen.push(init);
    return seen.length === 1
      ? Response.json({ code: 200, data: [{ FUNCENAME: 'EM_CSS', USEDDATA: 1 }] })
      : new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } });
  }));
  const table = await fetchNativeStatistics('https://fixture.invalid/', 'synthetic-token', { funcName: 'EM_CSS', indicators: 'FUNCENAME,USEDDATA' });
  expect(table.rows).toEqual([{ FUNCENAME: 'EM_CSS', USEDDATA: '1' }]);
  await expect(fetchNativeStatistics('https://fixture.invalid/', 'synthetic-token', {})).rejects.toThrow('statistics HTTP request failed');
  expect(seen.map(init => init.redirect)).toEqual(['manual', 'manual']);
});
