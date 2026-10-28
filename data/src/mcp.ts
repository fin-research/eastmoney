import { resolveTradingCalendarData } from './trading-calendar';
import { resolveChinamoneyData } from "./chinamoney";
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { resources, resourceRequest } from './resources';
import { resolveChoiceData } from './choice/routes';
import { resolveDmData } from './dm/routes';
import { resolveEastmoneyData } from './eastmoney-routes';
import { errorResponse } from './http';
import { readMcpMessage } from './mcp-request';

export const publishedMcpResources = resources.filter(resource => !['health', 'config', 'stock_summary'].includes(resource.name))
  .map(resource => ({ ...resource, name: resource.name === 'news' ? 'news_list' : resource.name }));

export async function handleMcp(context: Context<{ Bindings: Cloudflare.Env }>): Promise<Response> {
  if (context.req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const message = await readMcpMessage(context.req.raw);
  const call = message && typeof message === 'object' && 'method' in message && message.method === 'tools/call'
    && 'params' in message && message.params && typeof message.params === 'object' && 'name' in message.params ? message.params.name : undefined;
  // Per-request instances prevent sessions, credentials and bindings crossing
  // Worker invocations. Stateless JSON responses need no durable session store.
  const server = new McpServer({ name: 'eastmoney-data', version: '0.6.0' });
  for (const resource of publishedMcpResources) {
    if (typeof call === 'string' && resource.name !== call) continue;
    server.registerTool(resource.name, {
      title: resource.title,
      description: `${resource.group} · ${resource.title} (${resource.path})`,
      inputSchema: resource.input,
      outputSchema: z.object({ data: resource.output }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async input => {
      try {
        const request = resourceRequest(resource, input, context.req.url);
        const path = new URL(request.url).pathname;
        const data = resource.name === 'trading_days' ? await resolveTradingCalendarData(request, context.env, path)
          : resource.group === 'Choice' ? await resolveChoiceData(request, context.env, path)
          : resource.group === '中国货币网' ? await resolveChinamoneyData(request, context.env, path)
          : resource.group === 'DM' ? await resolveDmData(request, context.env, path)
          : await resolveEastmoneyData(request, context.env, path);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } };
      } catch (error) {
        const response = errorResponse(error);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: response.status, ...await response.json<Record<string, unknown>>() }) }] };
      }
    });
  }
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(context, message) ?? new Response(null, { status: 202 }); }
  finally { await server.close(); }
}
