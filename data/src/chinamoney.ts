import { z } from 'zod';
import { chinamoneyShiborSchema, parseObject, parseRows, projectRows } from './contracts';
import { ApiError, jsonResponse, requireMethod } from './http';
import { readUpstreamJson } from './upstream-diagnostics';
import { requireUpstreamCapacity } from './upstream-rate-limit';

const upstreamSchema = z.object({
  head: z.object({ rep_code: z.union([z.literal('200'), z.literal(200)]) }),
  data: z.object({ showDateCN: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/) }),
  records: z.array(z.object({ termCode: chinamoneyShiborSchema.shape.tenor, shibor: z.string().regex(/^-?\d+(?:\.\d+)?$/) })).max(8),
});

export async function resolveChinamoneyData(request: Request, env: Cloudflare.Env, pathname: string) {
  if (pathname !== '/chinamoney/shibor') return null;
  requireMethod(request, request.method === 'HEAD' ? 'HEAD' : 'GET');
  const url = new URL('https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/shibor/shibor.json');
  url.searchParams.set('t', String(Date.now()));
  await requireUpstreamCapacity(env.CHINAMONEY_LIMIT, 'chinamoney', 'ChinaMoney');
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'manual',
    headers: { Accept: 'application/json', Referer: 'https://www.chinamoney.com.cn/chinese/bkshibor/', 'X-Requested-With': 'XMLHttpRequest', 'Cache-Control': 'no-cache' },
    cf: { cacheTtl: 0 },
  });
  if (!response.ok) throw new ApiError(503, '中国货币网 SHIBOR 请求失败', { code: 'UPSTREAM_HTTP_ERROR', source: 'ChinaMoney', stage: 'fetch', upstreamStatus: response.status });
  const raw = parseObject(upstreamSchema, await readUpstreamJson(response, []), '中国货币网 SHIBOR');
  const publishDate = raw.data.showDateCN.slice(0, 10);
  const publishedAt = raw.data.showDateCN.replace(' ', 'T') + ':00+08:00';
  const rows = parseRows(chinamoneyShiborSchema, raw.records.map(row => ({ publishDate, publishedAt, tenor: row.termCode, rate: Number(row.shibor) })), '中国货币网 SHIBOR');
  if (new Set(rows.map(row => row.tenor)).size !== rows.length) throw new ApiError(503, '中国货币网 SHIBOR 期限重复');
  return projectRows(chinamoneyShiborSchema, rows, new URL(request.url).searchParams.get('fields'));
}

export async function handleChinamoneyRoute(request: Request, env: Cloudflare.Env, pathname: string) {
  const data = await resolveChinamoneyData(request, env, pathname);
  return data === null ? null : request.method === 'HEAD' ? new Response(null, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } }) : jsonResponse(data);
}
