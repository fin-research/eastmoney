import { afterEach, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/app';
import { allowRateLimits } from './rate-limit-bindings';
const env = { ...allowRateLimits() } as Cloudflare.Env;
const upstream = { head: { rep_code: '200' }, data: { showDateCN: '2026-09-15 11:00' }, records: [ { termCode: 'O/N', shibor: '1.4294', ignored: true }, { termCode: '1W', shibor: '1.5000' } ] };
afterEach(() => vi.restoreAllMocks());
it('forwards every read using POST and projects dated rates without caching', async () => {
  const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    expect(url.hostname).toBe('www.chinamoney.com.cn'); expect(url.searchParams.get('t')).toMatch(/^\d+$/);
    expect(request.method).toBe('POST'); expect(init?.redirect).toBe('manual'); expect(request.headers.get('Referer')).toContain('/chinese/bkshibor/');
    expect(request.headers.get('Cookie')).toBeNull(); expect(await request.text()).toBe('');
    return Response.json(upstream);
  });
  const get = () => handleRequest(new Request('https://test/data/chinamoney/shibor'), env);
  const response = await get(); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual([
    { publishDate: '2026-09-15', publishedAt: '2026-09-15T11:00:00+08:00', tenor: 'O/N', rate: 1.4294 },
    { publishDate: '2026-09-15', publishedAt: '2026-09-15T11:00:00+08:00', tenor: '1W', rate: 1.5 },
  ]);
  await get(); expect(upstreamFetch).toHaveBeenCalledTimes(2);
  const projected = await handleRequest(new Request('https://test/data/chinamoney/shibor?fields=tenor,rate'), env);
  expect(await projected.json()).toEqual([{ tenor: 'O/N', rate: 1.4294 }, { tenor: '1W', rate: 1.5 }]);
  const invalid = await handleRequest(new Request('https://test/data/chinamoney/shibor?fields=raw'), env);
  expect(invalid.status).toBe(422); expect(upstreamFetch).toHaveBeenCalledTimes(3);
});
it('GraphQL delegates to the same resource', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(upstream));
  const response = await handleRequest(new Request('https://test/graphql', { method:'POST', body:JSON.stringify({ query:'{ chinamoneyShibor(fields:"tenor,rate") }' }) }), env);
  expect(await response.json()).toEqual({ data: { chinamoneyShibor: [{tenor:'O/N',rate:1.4294},{tenor:'1W',rate:1.5}] } });
});
it('upstream HTTP and invalid rates fail instead of producing invented prices', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status:503 }));
  const get = () => handleRequest(new Request('https://test/chinamoney/shibor'), env);
  expect((await get()).status).toBe(503);
  mock.mockResolvedValue(Response.json({...upstream,records:[{termCode:'1W',shibor:'bad'}]}));
  expect((await get()).status).toBe(503);
});
