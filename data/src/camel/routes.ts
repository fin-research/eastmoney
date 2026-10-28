import { z } from 'zod';
import { ApiError, errorResponse, jsonResponse, parseDate } from '../http';
import { internalPathname } from '../routing';
import { camelDraftRequestSchema, camelImportRecordSchema } from './contracts';
import { camelService } from './service';
import type { CamelDependencies } from './client';

const MAX_FILE = 10 * 1024 * 1024;
async function boundedRequest(request: Request, maximum: number): Promise<Request> {
  if (Number(request.headers.get('content-length')) > maximum) throw new ApiError(413, '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(422, '请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new ApiError(413, '请求内容过大'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}
async function json<T>(request: Request, schema: z.ZodType<T>) {
  const bounded = await boundedRequest(request, 1024 * 1024);
  let value: unknown;
  try { value = await bounded.json(); } catch { throw new ApiError(422, 'JSON 格式无效'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, '拆借参数无效');
  return parsed.data;
}
function multipart(request: Request, extension: 'xlsx' | 'pdf'): Request {
  const mime = extension === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  let name: string;
  try { name = decodeURIComponent(request.headers.get('X-Filename') ?? ''); }
  catch { throw new ApiError(422, '文件名无效'); }
  if (!request.body || request.headers.get('Content-Type') !== mime || !name || name.length > 256 ||
    /[/\\:*?"<>|\x00-\x1f]/.test(name) || !name.toLowerCase().endsWith('.' + extension)) throw new ApiError(422, '文件类型或名称无效');
  if (Number(request.headers.get('content-length')) > MAX_FILE) throw new ApiError(413, '文件超过 10 MB');
  const boundary = 'camel-' + crypto.randomUUID();
  const encoder = new TextEncoder();
  let length = 0;
  // The internal API accepts exactly one raw file; only the adapter constructs multipart framing.
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`)); },
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > MAX_FILE) { controller.error(new ApiError(413, '文件超过 10 MB')); return; }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (!length) { controller.error(new ApiError(422, '文件不能为空')); return; }
      controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
    },
  }));
  return new Request(request.url, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, ...{ duplex: 'half' } });
}

/** InternalData and authorized GatewayData dispatch here; no GraphQL or MCP exposure. */
export async function handleCamelRequest(request: Request, env: Cloudflare.Env, dependencies: CamelDependencies = {}): Promise<Response | null> {
  const path = internalPathname(new URL(request.url).pathname);
  if (!path || !(path === '/camel' || path.startsWith('/camel/'))) return null;
  try {
    const params = new URL(request.url).searchParams;
    if (path === '/camel/borrowings') {
      for (const key of params.keys()) if (!['date', 'current', 'size'].includes(key) || params.getAll(key).length !== 1) throw new ApiError(400, '查询参数无效');
    } else if (params.size) throw new ApiError(400, '查询参数无效');
    const service = camelService(env, dependencies);
    if (path === '/camel/borrowings' && ['GET', 'HEAD'].includes(request.method)) {
      const date = parseDate(params.get('date') ?? '', 'date');
      const page = z.object({ current: z.coerce.number().int().min(1).max(2000), size: z.coerce.number().int().min(1).max(100) }).safeParse({
        current: params.get('current') ?? 1, size: params.get('size') ?? 50,
      });
      if (!page.success) throw new ApiError(422, '分页参数无效');
      return jsonResponse(await service.query(date, page.data.current, page.data.size));
    }
    if (path === '/camel/borrowings/parse' && request.method === 'POST') return jsonResponse(await service.parse(multipart(request, 'xlsx')));
    if (path === '/camel/borrowings/import' && request.method === 'POST') {
      const body = await json(request, z.object({ records: z.array(camelImportRecordSchema.strict()).min(1).max(200) }).strict());
      return jsonResponse(await service.importRecords(body.records));
    }
    if (path === '/camel/attachments' && request.method === 'POST') return jsonResponse(await service.upload(multipart(request, 'pdf')));
    if (path === '/camel/repayment-drafts' && request.method === 'POST') {
      const body = await json(request, camelDraftRequestSchema);
      return jsonResponse(await service.createDraft(body.date, body.serialNo, body.attachmentIds));
    }
    const match = /^\/camel\/repayment-drafts\/([^/]+)$/.exec(path);
    if (match && ['GET', 'HEAD'].includes(request.method)) {
      const hid = z.string().min(1).max(256).safeParse(decodeURIComponent(match[1]!));
      if (!hid.success) throw new ApiError(422, '草稿编号无效');
      return jsonResponse(await service.detail(hid.data));
    }
    return jsonResponse({ detail: 'Not Found' }, 404);
  } catch (error) { return errorResponse(error); }
}
