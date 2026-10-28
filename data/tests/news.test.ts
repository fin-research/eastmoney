import { describe, expect, it, vi } from "vitest";

import { handleRequest } from "../src/app";
import { fetchImportantNews } from "../src/dm/news";
import { allowRateLimits } from "./rate-limit-bindings";

describe("market briefing subrequest budget", () => {
  it("reserves the configured budget across list and detail requests", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      sentimentId: `S${index}`,
      newsId: `N${index}`,
      title: `新闻 ${index}`,
      issueTime: Date.parse("2026-08-28T12:00:00+08:00") - index,
      newsImportance: 2,
      newsTagsDTOList: [{ newsThirdTagName: "债券" }],
    }));
    const bindingFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/news/info")) {
        return Response.json({
          code: 0,
          data: {
            sentimentId: "detail",
            issueTime: Date.parse("2026-08-28T12:00:00+08:00"),
            content: "正文",
          },
        });
      }
      return Response.json({
        code: 0,
        data: { list: rows, hasNextPage: true, endPageId: "next" },
      });
    });
    const result = await fetchImportantNews({
      DM: { fetch: bindingFetch } as unknown as Fetcher,
      DM_COOKIE: "device_id=test",
      DM_LIMIT: allowRateLimits().DM_LIMIT,
    }, "2026-08-28", 50, 20, 3);

    expect(bindingFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(2);
  });
});

describe("news JSON container validation", () => {
  it.each([[], "not an object", 12, true])("rejects malformed upstream JSON container %j", async payload => {
    const response = await handleRequest(new Request("https://data/news"), {
      DM_COOKIE: "device_id=test", ...allowRateLimits(),
      DM: { fetch: async () => Response.json(payload) },
    } as unknown as Cloudflare.Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "UPSTREAM_SCHEMA_MISMATCH", stage: "response_validation" },
    });
  });
});

function batchEnv(options: { fail?: boolean; mismatch?: boolean } = {}) {
  const rows = Array.from({ length: 40 }, (_, i) => ({ sentimentId: `S${i}`, title: `新闻${i}`, issueTime: Date.parse('2026-10-26T15:00:00+08:00') - i, newsImportance: 2 }));
  const calls: string[] = []; let active = 0, maximum = 0;
  const env = { DM_COOKIE: 'device_id=test', ...allowRateLimits(), DM: { fetch: async (request: Request) => {
    const url = new URL(request.url); calls.push(url.pathname);
    if (url.pathname.endsWith('/news/info')) {
      const id = url.searchParams.get('sentimentId'); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      if (options.fail && id === 'S12') return new Response('failed', { status: 503 });
      return Response.json({ code: 0, data: { ...rows.find(row => row.sentimentId === id), sentimentId: options.mismatch ? 'wrong' : id, content: `正文${id}`, privateKey: 'hidden' } });
    }
    return Response.json({ code: 0, data: { list: rows, hasNextPage: false } });
  } } } as unknown as Cloudflare.Env;
  return { env, calls, maximum: () => maximum };
}
describe('news detail batches', () => {
  it('returns only requested bodies in order, with bounded concurrency and projected fields', async () => {
    const h = batchEnv();
    const response = await handleRequest(new Request('https://data/news?date=2026-10-26&detail=true&pageSize=10&offset=10&fields=sentimentId,content'), h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(Array.from({ length: 10 }, (_, i) => ({ sentimentId: `S${10 + i}`, content: `正文S${10 + i}` })));
    expect(h.calls).toHaveLength(11); expect(h.maximum()).toBeLessThanOrEqual(5);
  });
  it('keeps default summaries compatible and permits empty final page', async () => {
    const h = batchEnv();
    const response = await handleRequest(new Request('https://data/news?pageSize=10'), h.env);
    expect(response.status).toBe(200); expect(h.calls).toHaveLength(1);
    expect((await response.json() as Record<string, unknown>[])[0]).not.toHaveProperty('content');
    const empty = await handleRequest(new Request('https://data/news?detail=true&offset=50'), h.env);
    expect(await empty.json()).toEqual([]);
  });
  it.each(['detail=true&pageSize=11', 'detail=true&offset=91', 'detail=true&offset=-1', 'detail=invalid', 'offset=90&pageSize=20'])('rejects invalid bounded query %s before upstream', async query => {
    const h = batchEnv(); const response = await handleRequest(new Request('https://data/news?' + query), h.env);
    expect(response.status).toBe(422); expect(h.calls).toHaveLength(0);
  });
  it.each([{ fail: true }, { mismatch: true }])('fails entire batch on detail failure %j', async options => {
    const h = batchEnv(options); const response = await handleRequest(new Request('https://data/news?detail=true&pageSize=10&offset=10'), h.env);
    expect(response.status).toBe(503);
  });
  it('rejects an exhausted date scan instead of silently returning an incomplete batch', async () => {
    const h = batchEnv();
    h.env.DM = { fetch: async () => Response.json({ code: 0, data: { list: [{ sentimentId: 'newer', title: 'newer', issueTime: Date.parse('2026-10-26T15:00:00+08:00') }], hasNextPage: true, endPageId: 'repeated' } }) } as unknown as Fetcher;
    const response = await handleRequest(new Request('https://data/news?date=2026-10-23&detail=true'), h.env);
    expect(response.status).toBe(503);
  });
  it.each(['title', 'sentimentId', 'issueTime'])('fails detail pagination on missing %s instead of treating it as the final page', async field => {
    const h = batchEnv();
    const upstream = h.env.DM.fetch.bind(h.env.DM);
    h.env.DM = { fetch: async (request: Request) => {
      const response = await upstream(request);
      if (new URL(request.url).pathname.endsWith('/news/info')) return response;
      const body = await response.json() as { data: { list: Record<string, unknown>[] } };
      delete body.data.list[3]![field];
      return Response.json(body);
    } } as unknown as Fetcher;
    const response = await handleRequest(new Request('https://data/news?date=2026-10-26&detail=true&pageSize=10'), h.env);
    expect(response.status).toBe(503); expect(h.calls).toHaveLength(1);
  });
  it('does not validate unused title or ID fields on news outside the requested date', async () => {
    const h = batchEnv();
    const upstream = h.env.DM.fetch.bind(h.env.DM);
    h.env.DM = { fetch: async (request: Request) => {
      const response = await upstream(request);
      if (new URL(request.url).pathname.endsWith('/news/info')) return response;
      const body = await response.json() as { data: { list: Record<string, unknown>[] } };
      body.data.list.unshift({ issueTime: Date.parse('2026-10-27T09:00:00+08:00') });
      return Response.json(body);
    } } as unknown as Fetcher;
    const response = await handleRequest(new Request('https://data/news?date=2026-10-26&detail=true&pageSize=10'), h.env);
    expect(response.status).toBe(200);
    expect((await response.json() as { sentimentId: string }[]).map(row => row.sentimentId)).toEqual(Array.from({ length: 10 }, (_, i) => `S${i}`));
  });
  it('rejects an unreadable scan timestamp even beyond the requested batch', async () => {
    const h = batchEnv();
    const upstream = h.env.DM.fetch.bind(h.env.DM);
    h.env.DM = { fetch: async (request: Request) => {
      const response = await upstream(request);
      if (new URL(request.url).pathname.endsWith('/news/info')) return response;
      const body = await response.json() as { data: { list: Record<string, unknown>[] } };
      body.data.list.push({ sentimentId: 'unknown-date', title: '无法判断日期' });
      return Response.json(body);
    } } as unknown as Fetcher;
    const response = await handleRequest(new Request('https://data/news?date=2026-10-26&detail=true&pageSize=10'), h.env);
    expect(response.status).toBe(503);
    expect(h.calls).toHaveLength(1);
  });
  it('negative pageSize cannot reduce GraphQL alias budget', async () => {
    const h = batchEnv();
    const response = await handleRequest(new Request('https://data/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ bad: news(detail:true,pageSize:-100000) a: news(date:"2026-10-26",detail:true,pageSize:10) b: news(date:"2026-10-26",detail:true,pageSize:10) }' }) }), h.env);
    const body = await response.json() as { data: { bad: null; a: unknown[]; b: null }; errors: { extensions: { code?: string } }[] };
    expect(body.data.bad).toBeNull(); expect(body.data.a).toHaveLength(10); expect(body.data.b).toBeNull();
    expect(body.errors.some(error => error.extensions.code === 'QUERY_RESOURCE_LIMIT')).toBe(true); expect(h.calls).toHaveLength(11);
  });
  it('mirrors detail/offset on GraphQL and reserves body subrequests against aliases', async () => {
    const h = batchEnv();
    const response = await handleRequest(new Request('https://data/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ a: news(date:"2026-10-26",detail:true,pageSize:10,offset:10,fields:"sentimentId,content") b: news(date:"2026-10-26",detail:true,pageSize:10) }' }) }), h.env);
    const body = await response.json() as { data: { a: unknown[]; b: null }; errors: { extensions: { code: string } }[] };
    expect(body.data.a).toHaveLength(10); expect(body.data.b).toBeNull();
    expect(body.errors[0]?.extensions.code).toBe('QUERY_RESOURCE_LIMIT'); expect(h.calls).toHaveLength(11);
  });
});
