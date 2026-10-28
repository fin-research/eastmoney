import { AI_GATEWAY_MODEL, aiGatewayResponsesUrl } from './ai-gateway.ts';
import type { SiteIdentity } from '../identity.ts';

const MAX_REQUEST_BYTES = 1024 * 1024;
const PRIVATE = { 'Cache-Control': 'private, no-store, no-transform', Vary: 'Cookie, Authorization' };

export async function proxyAgentResponses(
  request: Request,
  env: Pick<Env, 'CLOUDFLARE_ACCOUNT_ID' | 'AI_GATEWAY_ID' | 'CF_AIG_TOKEN'>,
  user: SiteIdentity | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!user?.auth0Id) return Response.json({ error: '请先登录' }, { status: 401, headers: PRIVATE });
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: '请求来源不匹配' }, { status: 403, headers: PRIVATE });
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CF_AIG_TOKEN) {
    return Response.json({ error: 'AI Gateway 尚未配置' }, { status: 503, headers: PRIVATE });
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: '请求格式无效' }, { status: 415, headers: PRIVATE });
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) {
    return Response.json({ error: '请求过大' }, { status: 413, headers: PRIVATE });
  }
  let body: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('empty body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return Response.json({ error: '请求过大' }, { status: 413, headers: PRIVATE });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
    body = value as Record<string, unknown>;
  } catch {
    return Response.json({ error: '请求不是有效 JSON' }, { status: 400, headers: PRIVATE });
  }
  // The browser owns the loop, never the provider account or model selection.
  if (body.model !== AI_GATEWAY_MODEL || body.stream !== true || !Array.isArray(body.input)) {
    return Response.json({ error: '模型请求无效' }, { status: 400, headers: PRIVATE });
  }
  if (body.background || body.store || body.previous_response_id || body.conversation) {
    return Response.json({ error: '不支持远端会话状态' }, { status: 400, headers: PRIVATE });
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool: unknown) =>
    !tool || typeof tool !== 'object' || (tool as { type?: unknown }).type !== 'function'))) {
    return Response.json({ error: '工具请求无效' }, { status: 400, headers: PRIVATE });
  }
  if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1 || (body.max_output_tokens as number) > 12_000)) {
    return Response.json({ error: '输出长度超出限制' }, { status: 400, headers: PRIVATE });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  request.signal.addEventListener('abort', () => { clearTimeout(timeout); controller.abort(); }, { once: true });
  try {
    const upstream = await fetcher(aiGatewayResponsesUrl({ accountId: env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID || 'default' }), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
        'cf-aig-skip-cache': 'true',
        'cf-aig-collect-log': 'true',
        'cf-aig-request-timeout': '300000',
        'cf-aig-metadata': JSON.stringify({ task_type: 'browser_agent', ai_model: AI_GATEWAY_MODEL,
          ai_provider: 'custom-codex' }),
      },
      body: JSON.stringify({ ...body, store: false, max_output_tokens: body.max_output_tokens ?? 12_000 }),
      signal: controller.signal,
    });
    const headers = new Headers(PRIVATE);
    headers.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    headers.set('X-Content-Type-Options', 'nosniff');
    const stream = upstream.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) { output.enqueue(chunk); },
      flush() { clearTimeout(timeout); },
    }));
    if (!stream) clearTimeout(timeout);
    return new Response(stream, { status: upstream.status, headers });
  } catch {
    clearTimeout(timeout);
    return Response.json({ error: '模型服务暂时不可用' }, { status: 502, headers: PRIVATE });
  }
}
