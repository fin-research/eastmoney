import { z } from 'zod';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const comparison = z.object({ $eq: scalar.optional(), $ne: scalar.optional(), $gt: z.union([z.string(), z.number()]).optional(), $gte: z.union([z.string(), z.number()]).optional(), $lt: z.union([z.string(), z.number()]).optional(), $lte: z.union([z.string(), z.number()]).optional(), $in: z.array(scalar).optional(), $nin: z.array(scalar).optional() }).strict();
const filters = z.record(z.string(), z.union([scalar, comparison])).refine(value => {
  const date = value.published_at;
  return date === undefined || (date !== null && typeof date === 'object' && Object.keys(date).length > 0 && Object.entries(date).every(([key, value]) => ['$gt', '$gte', '$lt', '$lte'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value)));
}, 'published_at 必须使用 Unix 毫秒范围过滤');
export const researchSearchSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  ai_search_options: z.object({
    cache: z.object({ cache_threshold: z.string().optional(), enabled: z.boolean().optional() }).strict().optional(),
    custom_metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    query_rewrite: z.object({ enabled: z.literal(false).optional(), rewrite_prompt: z.string().optional() }).strict().optional(),
    reranking: z.object({ enabled: z.literal(false).optional(), match_threshold: z.number().optional() }).strict().optional(),
    retrieval: z.object({ context_expansion: z.number().int().nonnegative().optional(), filters: filters.optional(), fusion_method: z.enum(['max', 'rrf']).optional(), match_threshold: z.number().optional(), max_num_results: z.literal(50).optional(), metadata_only: z.boolean().optional(), retrieval_type: z.enum(['vector', 'keyword', 'hybrid']).optional(), return_on_failure: z.boolean().optional() }).strict().optional(),
  }).strict().optional(),
}).strict();
export class ResearchSearchError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function boundedText(source: Request | Response, limit: number, status = 502): Promise<string> {
  const reader = source.body?.getReader(); if (!reader) return '';
  const decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new ResearchSearchError(status, 'AI Search 内容超过大小限制'); text += decoder.decode(value, { stream: true }); }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function searchArguments(input: z.infer<typeof researchSearchSchema>, now = Date.now()) {
  const retrieval = input.ai_search_options?.retrieval;
  // Shanghai calendar dates, including today and the previous six days.
  const end = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000 + 86400000;
  return { ...input, ai_search_options: { ...input.ai_search_options, retrieval: { ...retrieval, max_num_results: 50, filters: { ...retrieval?.filters, published_at: retrieval?.filters?.published_at ?? { $gte: end - 7 * 86400000, $lt: end } } } } };
}
export function parseSearchResponse(text: string, id: string): unknown {
  const frames = text.trim().startsWith('{') ? [text] : text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean);
  for (const frame of frames) {
    let envelope; try { envelope = JSON.parse(frame); } catch { continue; }
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id) continue;
    if (envelope.error || envelope.result?.isError) throw new ResearchSearchError(502, 'AI Search MCP 检索失败');
    const content = envelope.result?.content;
    if (!Array.isArray(content)) break;
    for (const item of content) {
      if (item.type !== 'text' || typeof item.text !== 'string') continue;
      let data; try { data = JSON.parse(item.text); } catch { continue; }
      if (data.success === false || data.error || data.errors?.length) throw new ResearchSearchError(502, 'AI Search 上游检索失败');
      if (data.success === true && Array.isArray(data.result?.chunks)) return data;
    }
    break;
  }
  throw new ResearchSearchError(502, 'AI Search MCP 响应无效');
}
export async function researchSearch(input: z.infer<typeof researchSearchSchema>, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const id = crypto.randomUUID();
  const response = await fetcher('https://research.hasbai.xyz/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: searchArguments(input) } }), signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) });
  const text = await boundedText(response, 6 * 1024 * 1024);
  if (!response.ok) throw new ResearchSearchError(502, `AI Search 检索失败（HTTP ${response.status}）`);
  return parseSearchResponse(text, id);
}
export async function handleResearchSearch(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store, private' };
  try {
    const text = await boundedText(request, 1024 * 1024, 413);
    let input; try { input = researchSearchSchema.safeParse(JSON.parse(text)); } catch { throw new ResearchSearchError(400, '检索参数无效'); }
    if (!input.success) throw new ResearchSearchError(400, '检索参数无效');
    return Response.json(await researchSearch(input.data, request.signal, fetcher), { headers });
  } catch (error) { return Response.json({ error: error instanceof ResearchSearchError ? error.message : 'AI Search 暂时不可用' }, { status: error instanceof ResearchSearchError ? error.status : 503, headers }); }
}
