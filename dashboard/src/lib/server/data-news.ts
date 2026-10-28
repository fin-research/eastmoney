import { z } from "zod";

const MAX_DATA_RESPONSE_BYTES = 5 * 1024 * 1024;

const dataNewsDetailSchema = z.object({
  content: z.string().min(1),
  link: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
}).passthrough();

export interface DataNewsDetail {
  content: string;
  link: string | null;
}

export async function fetchDataNewsDetail(env: Env, articleId: string): Promise<DataNewsDetail> {
  const baseUrl = env.DATA_API_BASE_URL || "https://eastmoney.hasbai.xyz/data";
  const url = `${baseUrl}/news/${encodeURIComponent(articleId)}?fields=content,link`;
  const request = new Request(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  let response: Response;
  try {
    response = env.DATA ? await env.DATA.fetch(request) : await fetch(request);
  } catch (error) {
    throw new DataNewsError(
      503,
      `研报正文读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DataNewsError(
      response.status === 404 ? 404 : 503,
      response.status === 404 ? "研报正文不存在" : `研报正文读取失败（HTTP ${response.status}）`,
    );
  }

  const text = await readTextBounded(response, MAX_DATA_RESPONSE_BYTES);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DataNewsError(503, "研报正文返回的不是有效 JSON");
  }
  const parsed = dataNewsDetailSchema.safeParse(payload);
  if (!parsed.success) throw new DataNewsError(503, "研报正文不符合接口 Schema");
  return { content: parsed.data.content, link: parsed.data.link || null };
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DataNewsError(503, "研报正文响应过大");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("response too large");
      throw new DataNewsError(503, "研报正文响应过大");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class DataNewsError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DataNewsError";
    this.status = status;
  }
}
