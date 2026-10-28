import { createHash } from 'node:crypto';
import { CssResponseArchiveError, type CaptureDataResponse } from './css-response-evidence.ts';
export type EconomicIndicatorRequestDetails = {
  path: string;
  parameters: Record<string, string>;
  stage: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  requestId?: string;
  responseBody?: string;
  responseTruncated?: boolean;
  cause?: { name: string; message: string };
};

export class EconomicIndicatorRequestError extends Error {
  readonly details: EconomicIndicatorRequestDetails;
  constructor(details: EconomicIndicatorRequestDetails) {
    // Workflow persists Error.message for every attempt; custom properties alone
    // do not survive its serialization boundary. Keep diagnostics ahead of long
    // Choice code lists so platform-truncated step output still shows the cause.
    const { parameters, ...diagnostics } = details;
    super(JSON.stringify({ ...diagnostics, parameters }));
    this.name = "EconomicIndicatorRequestError";
    this.details = details;
  }
}

export function redactEconomicIndicatorError(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\b((?:[\w-]*(?:token|secret|password|passwd|cookie|authorization|credential|signature)|sign|device_id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;<>]+)/gi, "$1[REDACTED]");
}

export function economicIndicatorErrorDetails(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: redactEconomicIndicatorError(error instanceof Error ? error.message : String(error)).slice(0, 32_000),
  };
}

export async function requestEconomicIndicatorData(
  data: { fetch(request: Request): Promise<Response> },
  path: string,
  parameters: URLSearchParams,
  capture?: CaptureDataResponse,
): Promise<unknown> {
  const url = new URL(`https://eastmoney.hasbai.xyz/data${path}`);
  url.search = parameters.toString();
  // Parameters here are the EDB/funding query allowlist, never signed upstream URLs.
  const details: EconomicIndicatorRequestDetails = {
    path, parameters: Object.fromEntries(parameters), stage: "fetch",
  };
  const persist = async (body: string | null, stage: string, complete: boolean,
    receivedBytes: number, retainedBytes: number, digest: string | null, response?: Response) => {
    if (!capture) return;
    const clean = body === null ? null : redactEconomicIndicatorError(body);
    try { await capture({ capturedAt: new Date().toISOString(), stage,
      status: response?.status ?? null,
      requestId: response?.headers.get('X-Request-Id') || null,
      cfRay: response?.headers.get('CF-Ray') || null,
      complete, receivedBytes, retainedBytes, rawBodySha256: complete ? digest : null,
      retainedBodySha256: digest, body: clean, redacted: clean !== body }); }
    catch { throw new CssResponseArchiveError(); }
  };
  let response: Response;
  try {
    response = await data.fetch(new Request(url, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000),
    }));
  } catch (error) {
    await persist(null, 'fetch', false, 0, 0, null);
    throw new EconomicIndicatorRequestError({ ...details, cause: economicIndicatorErrorDetails(error) });
  }
  Object.assign(details, {
    status: response.status, statusText: response.statusText,
    contentType: response.headers.get("Content-Type") ?? "",
    requestId: response.headers.get("CF-Ray") ?? response.headers.get("X-Request-Id") ?? "",
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const limit = response.ok ? 8 * 1024 * 1024 : 24_000;
  let text = "";
  let bytes = 0;
  let truncated = false;
  let retained = 0;
  const hash = capture ? createHash('sha256') : undefined;
  try {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const kept = chunk.value.subarray(0, limit + 1 - bytes);
      hash?.update(kept); retained += kept.byteLength;
      text += decoder.decode(kept, { stream: true });
      bytes += chunk.value.byteLength;
      if (bytes > limit) { truncated = true; break; }
    }
    text += decoder.decode();
  } catch (error) {
    await persist(text, 'read_response', false, bytes, retained, hash?.digest('hex') ?? null, response);
    throw new EconomicIndicatorRequestError({ ...details, stage: "read_response",
      responseBody: redactEconomicIndicatorError(text).slice(0, 24_000),
      responseTruncated: truncated, cause: economicIndicatorErrorDetails(error) });
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  const digest = hash?.digest('hex') ?? null;
  if (!response.ok || truncated) {
    await persist(text, response.ok ? 'response_size' : 'http_response', !truncated, bytes, retained, digest, response);
    throw new EconomicIndicatorRequestError({ ...details,
      stage: response.ok ? "response_size" : "http_response",
      responseBody: redactEconomicIndicatorError(text).slice(0, 24_000), responseTruncated: truncated });
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    await persist(text, 'decode_json', true, bytes, retained, digest, response);
    throw new EconomicIndicatorRequestError({ ...details, stage: "decode_json",
      responseBody: redactEconomicIndicatorError(text).slice(0, 24_000),
      responseTruncated: text.length > 24_000, cause: economicIndicatorErrorDetails(error) });
  }
  await persist(text, 'success', true, bytes, retained, digest, response);
  return value;
}
