import { expect, it, vi } from 'vitest';
import { handleGatewayRequest, handlePublicRequest } from '../src/public-access';
const env = () => ({} as Cloudflare.Env);
const context = (status = 401) => Buffer.from(JSON.stringify({ version: 1, user: null, choice: { status } })).toString('base64url');

it('public origin rejects every path, method, JWT and forged context without reaching upstream', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  try {
    for (const path of ['/health', '/data/health', '/data/choice/css', '/data/graphql', '/GatewayData', '/InternalData']) {
      for (const method of ['GET', 'POST', 'DELETE']) for (const headers of [{} as Record<string, string>, { Authorization: 'Bearer forged', 'X-Eastmoney-Gateway-Context': context(204), 'X-Internal-Service': 'dashboard' }]) {
        expect((await handlePublicRequest(new Request('https://data.workers.dev' + path, { method, headers }), env())).status).toBe(404);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await handleGatewayRequest(new Request('https://data.internal/data/health'), env())).status).toBe(503);
    expect((await handleGatewayRequest(new Request('https://data.internal/data/health', { headers: { 'X-Eastmoney-Gateway-Context': context() } }), env())).status).toBe(200);
  } finally { fetcher.mockRestore(); }
});

function graphqlRequest(query: string, cookie = '', extra: Record<string, unknown> = {}) {
  return new Request('https://example.test/data/graphql', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Eastmoney-Gateway-Context': context(cookie ? 204 : 401) }, body: JSON.stringify({ query, ...extra }) });
}

it('GraphQL exposes public reads while aliases, fragments and mixed queries cannot bypass Choice login', async () => {
  const rpc = vi.fn();
  const configEnv = { ...env(), CHOICE_RPC: { fetch: rpc } } as unknown as Cloudflare.Env;
  const queries = [
    '{ health private: choiceCtr(reportName: "fixture") { rows } }',
    'query { ...Limited } fragment Limited on Query { choiceEdb(edbIds: "1", startDate: "2026-01-01", endDate: "2026-01-02") { rows } }',
    '{ choiceCss(codes: "fixture", indicators: "CLOSE") { rows } }',
    '{ choiceCsd(codes: "fixture", indicators: "CLOSE", startDate: "2026-01-01", endDate: "2026-01-02") { rows } }',
    '{ choiceDataStatistics { rows } }',
  ];
  for (const query of queries) {
    const response = await handleGatewayRequest(graphqlRequest(query), configEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as { data: Record<string, unknown>; errors: { extensions: Record<string, unknown> }[] };
    expect(body.errors[0]?.extensions).toEqual({ code: 'LOGIN_REQUIRED', status: 401 });
    if (query.includes('health')) expect(body.data.health).toEqual({ status: 'ok' });
  }
  expect(rpc).not.toHaveBeenCalled();
  const response = await handleGatewayRequest(graphqlRequest('{ health config }'), configEnv);
  expect(await response.json()).toMatchObject({ data: { health: { status: 'ok' }, config: { defaultDate: expect.any(String) } } });
  const selected = await handleGatewayRequest(graphqlRequest('query Public { health } query Private { choiceCtr(reportName: "fixture") { rows } }', '', { operationName: 'Public' }), configEnv);
  expect(await selected.json()).toEqual({ data: { health: { status: 'ok' } } });
  const skipped = await handleGatewayRequest(graphqlRequest('{ health choiceCtr(reportName: "fixture") @skip(if: true) { rows } }'), configEnv);
  expect(await skipped.json()).toEqual({ data: { health: { status: 'ok' } } });
  expect((await handleGatewayRequest(new Request('https://example.test/data/graphql', { method: 'POST', headers: { 'X-Eastmoney-Gateway-Context': context() }, body: 'invalid' }), configEnv)).status).toBe(400);
});

it('Gateway-authorized GraphQL Choice reads use the verdict and preserve the original POST body', async () => {
  const rpc = vi.fn();
  const authorize = vi.fn();
  const configEnv = { ...env(), CHOICE_RPC: { fetch: rpc }, AUTHORIZATION: { fetch: authorize } } as unknown as Cloudflare.Env;
  try {
    const cookie = 'gateway-verified-test-account';
    // Empty required value reaches normal validation (no paid upstream call).
    const response = await handleGatewayRequest(graphqlRequest('{ health choiceCtr(reportName: "") { rows } }', cookie), configEnv);
    const body = await response.json() as { data: Record<string, unknown>; errors: { message: string; extensions: Record<string, unknown> }[] };
    expect(body.data.health).toEqual({ status: 'ok' });
    expect(body.errors[0]?.message).toContain('reportName');
    expect(body.errors[0]?.extensions?.code).not.toBe('LOGIN_REQUIRED');
    expect(rpc).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

it('public GraphQL DM and Eastmoney fields reach their normal validators without identity', async () => {
  const response = await handleGatewayRequest(graphqlRequest('{ health news(pageSize: 0) margin(date: "invalid") }'), env());
  const body = await response.json() as { data: Record<string, unknown>; errors: { message: string; extensions?: Record<string, unknown> }[] };
  expect(body.data).toEqual({ health: { status: 'ok' }, news: null, margin: null });
  expect(body.errors.map(error => error.message)).toEqual(expect.arrayContaining([
    expect.stringContaining('pageSize'), expect.stringContaining('date'),
  ]));
  expect(body.errors.every(error => error.extensions?.code !== 'LOGIN_REQUIRED')).toBe(true);
});
