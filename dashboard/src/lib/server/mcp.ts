import { Buffer } from 'node:buffer';
import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { parse, unflatten } from 'devalue';
import { z } from 'zod';
import { CONTEXT_HEADER } from './gateway-context.ts';
import type { SiteIdentity } from '../identity.ts';
import { projectBondLedgerResult } from './mcp-bond-ledger.ts';
import { projectCommentaryResult } from './mcp-commentary.ts';
import { mcpOperations, operationPath, type McpOperation } from './mcp-catalog.ts';

const publishedNames = new Set([
  'credit_report', 'market_report', 'save_market_report', 'hotspots', 'policies', 'research_search', 'policy_articles',
  'update_policy_articles', 'article', 'news', 'commentaries', 'commentary', 'commentary_revisions',
  'create_commentary', 'update_commentary', 'economic_indicators', 'bond_ledger', 'bond_ledger_import', 'bond_investor_reference', 'create_bond_investor', 'update_bond_investor', 'financing_clients', 'create_client', 'update_client',
]);
const publishedOperations = mcpOperations.filter(operation => publishedNames.has(operation.name));
// bond_ledger_import carries the base64 xlsx original plus parsed rows, so the
// JSON-RPC envelope needs room for a single <1 MB ledger; business limits still apply.
const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const privateHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization' };
class McpBusinessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function boundedText(source: Request | Response, limit: number): Promise<string> {
  const reader = source.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new McpBusinessError(413, '内容超过 MCP 大小限制，请缩小查询范围');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function contextHeaders(user: SiteIdentity) {
  return new Headers({ [CONTEXT_HEADER]: Buffer.from(JSON.stringify({ version: 1, user, choice: { status: 401 } })).toString('base64url') });
}
async function policies(env: Pick<Env, 'IDENTITY'>, user: SiteIdentity) {
  const headers = contextHeaders(user); headers.set('Content-Type', 'application/json');
  const response = await env.IDENTITY.fetch(new Request('https://identity.internal/mcp/policies', { method: 'POST', headers,
    body: JSON.stringify(publishedOperations.map(operation => ({ path: operationPath(operation, {}), method: operation.method }))) }));
  if (!response.ok) throw new McpBusinessError(response.status, 'MCP 权限检查失败');
  return z.object({ allowed: z.array(z.boolean()).length(publishedOperations.length) }).parse(JSON.parse(await boundedText(response, MAX_REQUEST))).allowed;
}
export async function decodeBusinessResponse(response: Response, operation: Pick<McpOperation, 'format'>): Promise<unknown> {
  const text = await boundedText(response, MAX_RESPONSE);
  if (!response.ok) {
    let message = `业务请求失败（HTTP ${response.status}）`;
    try { const value = JSON.parse(text); message = value.detail || value.message || (typeof value.error === 'string' ? value.error : message); } catch { /* no raw HTML/errors */ }
    throw new McpBusinessError(response.status, message);
  }
  if (operation.format === 'html') return { html: text };
  const value = JSON.parse(text);
  if (operation.format === 'form') {
    const data = typeof value.data === 'string' ? parse(value.data) : value.data;
    if (value.type === 'failure' || value.type === 'error') return { failed: true, status: value.status, data: data ?? value.error };
    return value.type === 'redirect' ? { saved: true, location: value.location } : data ?? value;
  }
  if (operation.format === 'page') {
    if (value.type !== 'data' || !Array.isArray(value.nodes)) throw new McpBusinessError(502, '页面数据响应无效');
    const node = value.nodes.at(-1);
    if (!node || node.type !== 'data') throw new McpBusinessError(node?.status ?? 502, '业务数据读取失败');
    return unflatten(node.data);
  }
  return value;
}
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function bondLedgerUploadForm(input: Record<string, unknown>): FormData {
  const bytes = Buffer.from(String(input.fileBase64 ?? ''), 'base64');
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: XLSX_CONTENT_TYPE }), String(input.fileName ?? ''));
  form.set('parsed', JSON.stringify(input.parsed ?? {}));
  if (input.expectedDate) form.set('expectedDate', String(input.expectedDate));
  return form;
}
export async function executeOperation(operation: McpOperation, input: Record<string, unknown>, env: Pick<Env, 'IDENTITY'>, user: SiteIdentity, signal?: AbortSignal) {
  const path = operationPath(operation, input, true);
  const headers = contextHeaders(user);
  let body: string | URLSearchParams | FormData | undefined;
  if (operation.format === 'upload') {
    // FormData sets its own multipart Content-Type with boundary; IDENTITY keeps it while forwarding.
    headers.set('Accept', 'application/json');
    body = bondLedgerUploadForm(input);
  } else if (operation.format === 'form') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded'); headers.set('X-SvelteKit-Action', 'true');
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(input.form as Record<string, unknown>)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
    }
  } else if (!['GET', 'DELETE'].includes(operation.method)) {
    headers.set('Content-Type', 'application/json'); body = JSON.stringify(input.body ?? {});
  }
  // IDENTITY rechecks the real route permission before dispatching through the
  // private GatewayDashboard entrypoint. No public fetch or local auth bypass.
  const response = await env.IDENTITY.fetch(new Request('https://identity.internal/mcp/dispatch?target=' + encodeURIComponent(path), {
    method: operation.method, headers, body, signal,
  }));
  return decodeBusinessResponse(response, operation);
}
export async function handleDashboardMcp(request: Request, env: Pick<Env, 'IDENTITY'>, user: SiteIdentity | null): Promise<Response> {
  if (!user) return Response.json({ error: '请先登录' }, { status: 401, headers: privateHeaders });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: 'POST' } });
  try {
    // Limit bytes before SDK JSON parsing, including chunked requests.
    const body = await boundedText(request, MAX_REQUEST);
    const headers = new Headers(request.headers); headers.delete('Content-Length');
    const bounded = new Request(request, { headers, body });
    const handler = createMcpHandler(async () => {
      const server = new McpServer({ name: 'eastmoney-dashboard', version: '1.0.0' }, { capabilities: { tools: {} } });
      const allowed = await policies(env, user);
      publishedOperations.forEach((operation, index) => {
        if (!allowed[index]) return;
        const readOnly = operation.readOnly === true || operation.method === 'GET' || operation.name === 'liability_report_data';
        server.registerTool(operation.name, { title: operation.title,
          description: `${operation.title}。${operation.description ?? ''} ${operation.method} ${operation.path}${operation.action ? '?/' + operation.action : ''}`,
          inputSchema: operation.input, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
        }, async (input) => {
          try {
            const result = await executeOperation(operation, input as Record<string, unknown>, env, user, request.signal);
            const data = operation.name === 'bond_ledger' ? projectBondLedgerResult(input as Record<string, unknown>, result) : projectCommentaryResult(operation.name, result);
            const failed = Boolean(data && typeof data === 'object' && 'failed' in data && data.failed);
            return { ...(failed ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } };
          } catch (error) {
            const status = error instanceof McpBusinessError ? error.status : 503;
            const detail = error instanceof McpBusinessError ? error.message : '业务执行失败，请先核对当前记录或历史结果，避免重复提交';
            return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ status, detail }) }] };
          }
        });
      });
      return server;
    }, { route: '/api/mcp', corsOptions: false, allowedHostnames: ['eastmoney.hasbai.xyz'], allowedOriginHostnames: ['eastmoney.hasbai.xyz'] });
    const response = await handler.fetch(bounded);
    const result = new Response(response.body, response);
    for (const [name, value] of Object.entries(privateHeaders)) result.headers.set(name, value);
    return result;
  } catch (error) {
    return Response.json({ error: error instanceof McpBusinessError ? error.message : 'MCP 服务暂时不可用' }, { status: error instanceof McpBusinessError ? error.status : 503, headers: privateHeaders });
  }
}
