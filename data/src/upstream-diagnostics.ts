// Error responses are useful evidence, but may echo the signed request or secrets.
// Keep only a bounded, redacted body and selected non-secret response headers.
export const ERROR_BODY_LIMIT = 8192;

export type UpstreamResponseDetails = {
  status: number;
  statusText: string;
  contentType: string;
  requestId: string | null;
  body: string;
  truncated: boolean;
  readError?: string;
};

const sensitiveKey = /authorization|cookie|password|passwd|secret|token|credential|signature|^sign$|device.?id/i;

export function redactDiagnosticText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
    result = result.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return result
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\b((?:[\w-]*(?:token|secret|password|passwd|cookie|authorization|credential|signature)|sign|device_id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;<>]+)/gi, "$1[REDACTED]");
}

export function diagnosticSecrets(cookie: string): string[] {
  return [cookie, ...cookie.split(";").map((part) => part.slice(part.indexOf("=") + 1).trim())];
}

export function diagnosticBody(text: string, secrets: readonly string[] = []): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed, (key, value: unknown) => {
      if (sensitiveKey.test(key)) return "[REDACTED]";
      return typeof value === "string" ? redactDiagnosticText(value, secrets) : value;
    }).slice(0, ERROR_BODY_LIMIT);
  } catch {
    return redactDiagnosticText(text, secrets).slice(0, ERROR_BODY_LIMIT);
  }
}

export function responseDetails(
  response: Response,
  text: string,
  secrets: readonly string[] = [],
  truncated = false,
): UpstreamResponseDetails {
  return {
    status: response.status,
    statusText: redactDiagnosticText(response.statusText, secrets),
    contentType: redactDiagnosticText(response.headers.get("Content-Type") ?? "", secrets).slice(0, 200),
    requestId: redactDiagnosticText(response.headers.get("CF-Ray") ?? response.headers.get("X-Request-Id") ?? "", secrets).slice(0, 200) || null,
    body: diagnosticBody(text, secrets),
    truncated: truncated || text.length > ERROR_BODY_LIMIT,
  };
}

export async function readUpstreamError(
  response: Response,
  secrets: readonly string[] = [],
): Promise<UpstreamResponseDetails> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  let readError: string | undefined;
  try {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = ERROR_BODY_LIMIT + 1 - bytes;
      text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      bytes += chunk.value.byteLength;
      if (bytes > ERROR_BODY_LIMIT) { truncated = true; break; }
    }
    text += decoder.decode();
  } catch (error) {
    readError = redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  return { ...responseDetails(response, text, secrets, truncated), ...(readError ? { readError } : {}) };
}

export class UpstreamPayloadError extends Error {
  constructor(readonly details: UpstreamResponseDetails, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UpstreamPayloadError";
  }
}

// Reading once keeps a bounded prefix available when HTTP 200 carries HTML,
// malformed JSON, or a business error, without teeing and buffering a clone.
export async function readUpstreamJson(response: Response, secrets: readonly string[]): Promise<unknown> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const limit = 8 * 1024 * 1024;
  let text = "";
  let bytes = 0;
  try {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value.subarray(0, limit + 1 - bytes), { stream: true });
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error(`Upstream JSON exceeds ${limit} bytes`);
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    const cause = redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);
    throw new UpstreamPayloadError(responseDetails(response, text.slice(0, ERROR_BODY_LIMIT + 1), secrets, bytes > ERROR_BODY_LIMIT), new Error(cause));
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}
