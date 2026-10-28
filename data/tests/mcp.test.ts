import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleRequest } from '../src/app';
import { handleGatewayRequest, handlePublicRequest } from '../src/public-access';
import { resources } from '../src/resources';
import { publishedMcpResources } from '../src/mcp';
import openapi from '../src/openapi.json';
import { allowRateLimits } from './rate-limit-bindings';

function fixture() {
  const upstream = vi.fn(async () => new Response('unexpected upstream', { status: 500 }));
  const env = { DM: { fetch: upstream }, DM_COOKIE: 'fixture', CHOICE_RPC: { fetch: upstream }, CHOICE_RPC_TOKEN: 'fixture', ...allowRateLimits() } as unknown as Cloudflare.Env;
  const client = new Client({ name: 'contract-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('https://unit.test/data/mcp'), {
    fetch: async (url, init) => handleRequest(new Request(String(url), init), env),
  });
  return { client, transport, env, upstream };
}

describe('shared REST / OpenAPI / MCP contracts', () => {
  it('documents the public prefix, source groups and current authentication', () => {
    expect(openapi.servers).toEqual([{ url: '/data', description: '本站 Gateway Data API' }]);
    expect(Object.keys(openapi.components.securitySchemes)).toEqual(['Auth0Bearer']);
    expect(JSON.stringify(openapi)).not.toMatch(/GatewaySession|__Host-eastmoney_session|CF_Authorization|AccessCookie|AccessAssertion|Cf-Access/);
    for (const resource of resources) {
      const operation = (openapi.paths as Record<string, { get?: { tags: string[]; security?: { Auth0Bearer: never[] }[] } }>)[resource.path]?.get;
      expect(operation?.tags).toEqual([resource.group]);
      expect(operation?.security).toEqual(resource.login ? [{ Auth0Bearer: [] }] : undefined);
    }
    expect('/mcp' in openapi.paths).toBe(false);
    expect(openapi.security).toEqual([]);
  });
  it('supports initialize, tools/list and repeated stateless calls using the real SDK', async () => {
    const { client, transport, upstream } = fixture();
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name).sort()).toEqual(publishedMcpResources.map(resource => resource.name).sort());
      const cfets = list.tools.find(tool => tool.name === 'cfets_histories')!;
      expect(cfets.inputSchema.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
      expect(list.tools).toHaveLength(22);
      expect(list.tools.map(tool => tool.name)).toContain('news_list');
      expect(list.tools.map(tool => tool.name)).not.toContain('news');
      upstream.mockImplementation(async () => Response.json({ function: 'CSS', fields: ['RATE'], rows: [{ RATE: 1.5 }] }, { headers: { 'X-Choice-Rpc-Version': 'choice.rpc.v1' } }));
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({ name: 'choice_css', arguments: {codes:'000001.SH',indicators:'RATE'} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ data: { function: 'CSS', fields: ['RATE'], rows: [{ RATE: 1.5 }] } });
      }
      expect(upstream).toHaveBeenCalledTimes(2);
      upstream.mockClear();
      for (const name of ['health','config','stock_summary','news','camel_borrowings']) await expect(client.callTool({name,arguments:{}})).rejects.toThrow();
      for (const args of [{}, { codes: 'a', indicators: 'b', startDate: '2026-09-09', endDate: '2026-09-01' }]) {
        const result = await client.callTool({ name: 'choice_csd', arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(upstream).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
  it('keeps default entrypoint closed and checks the Gateway MCP verdict before execution', async () => {
    const { env, upstream } = fixture();
    const make = (status: number) => new Request('https://unit.test/data/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Eastmoney-Gateway-Context': Buffer.from(JSON.stringify({ version: 1, choice: { status } })).toString('base64url'),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await handlePublicRequest(make(204), env)).status).toBe(404);
    for (const status of [401, 403, 503]) expect((await handleGatewayRequest(make(status), env)).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('executes Choice tools through the existing private RPC client and validates its DTO', async () => {
    const { client, transport, upstream } = fixture();
    upstream.mockImplementation(async () => Response.json({ function: 'CSS', fields: ['RATE'], rows: [{ RATE: 1.5 }] }, { headers: { 'X-Choice-Rpc-Version': 'choice.rpc.v1' } }));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'choice_css', arguments: { codes: '000001.SH', indicators: 'RATE' } });
      expect(result.structuredContent).toEqual({ data: { function: 'CSS', fields: ['RATE'], rows: [{ RATE: 1.5 }] } });
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });
  it('dispatches the calendar tool to the same validated Choice calendar as REST', async () => {
    const {client,transport,upstream}=fixture();
    upstream.mockImplementation(async()=>Response.json({function:'TRADEDATES',fields:['date'],rows:[{date:'2026-09-30'}]}, {headers:{'X-Choice-Rpc-Version':'choice.rpc.v1'}}));
    try {
      await client.connect(transport);
      const result=await client.callTool({name:'trading_days',arguments:{date:'2026-10-01'}});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({data:{date:'2026-10-01',isTradingDay:false,previousTradingDate:'2026-09-30'}});
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {await client.close();}
  });
  it('validates HTTP numbers, dates and field allowlists before upstream calls', async () => {
    const { env, upstream } = fixture();
    for (const path of ['/cfets-histories?bondCode=DR007&limit=101', '/news?pageSize=0', '/news?date=2026-02-30', '/news?fields=privateSecret']) {
      expect((await handleRequest(new Request('https://unit.test/data' + path), env)).status).toBe(422);
    }
    expect(upstream).not.toHaveBeenCalled();
    const oversized = await handleRequest(new Request('https://unit.test/data/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(65537) }), env);
    expect(oversized.status).toBe(413);
  });
  it('preserves MCP protocol errors instead of reporting an upstream 503', async () => {
    const { env } = fixture();
    const response = await handleRequest(new Request('https://unit.test/data/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/plain' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env);
    expect(response.status).toBe(406);
    expect((await response.json() as { error: unknown }).error).toBeDefined();
    const discovery = await handleRequest(new Request('https://unit.test/data/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'discovery', method: 'server/discover', params: {} }) }), env);
    expect(discovery.status).toBe(404);
    const initialize = await handleRequest(new Request('https://unit.test/data/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'portal-fallback', version: '1' } } }) }), env);
    expect(initialize.status).toBe(200);
  });
});
