import type { UpstreamResponseDetails } from "./upstream-diagnostics";

export interface ApiErrorIssue {
  path: string;
  code: string;
  message: string;
  receivedType: string;
  receivedValue?: string | number | boolean | null;
}

export interface ApiErrorDetails {
  code: string;
  source?: string;
  stage?: string;
  upstreamStatus?: number;
  upstreamPath?: string;
  upstreamCode?: string | number;
  upstreamMessage?: string;
  upstreamResponse?: UpstreamResponseDetails;
  cause?: { name: string; message: string };
  issues?: ApiErrorIssue[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly details?: ApiErrorDetails,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function textResponse(
  value: string,
  contentType: string,
  status = 200,
): Response {
  return new Response(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    },
  });
}

export function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    const details = error.details ?? (error.status >= 500
      ? { code: "UPSTREAM_ERROR", stage: "request_handler" }
      : undefined);
    const response = jsonResponse({
      detail: error.detail,
      ...(details ? { error: details } : {}),
    }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return jsonResponse({
      detail: "upstream request timed out",
      error: { code: "UPSTREAM_TIMEOUT", stage: "fetch" },
    }, 504);
  }
  console.error(
    JSON.stringify({
      event: "data_api_request_failed",
      error: error instanceof Error ? error.name : "unknown",
      // Unknown handlers may include credentials; adapters capture safe details.
      frames: error instanceof Error ? error.stack?.split("\n").slice(1, 5).filter(line => /^\s*at /.test(line)) : undefined,
    }),
  );
  return jsonResponse({
    detail: "upstream request failed",
    error: { code: "UNEXPECTED_ERROR", stage: "request_handler" },
  }, 503);
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new ApiError(405, "Method Not Allowed");
  }
}

export function optionalParameter(
  parameters: URLSearchParams,
  name: string,
  maximumLength: number,
): string {
  const value = parameters.get(name)?.trim() ?? "";
  if (value.length > maximumLength) {
    throw new ApiError(422, `String should have at most ${maximumLength} characters`);
  }
  return value;
}

export function requiredParameter(
  parameters: URLSearchParams,
  name: string,
  maximumLength: number,
): string {
  const value = optionalParameter(parameters, name, maximumLength);
  if (!value) throw new ApiError(422, `Field required: ${name}`);
  return value;
}

export function normalizeCsv(
  value: string,
  name: string,
  options: { required?: boolean; maximumItems?: number } = {},
): string {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if ((options.required ?? true) && items.length === 0) {
    throw new ApiError(422, `${name} 不能为空`);
  }
  if (options.maximumItems !== undefined && items.length > options.maximumItems) {
    throw new ApiError(422, `${name} 单次最多支持 ${options.maximumItems} 项`);
  }
  return items.join(",");
}

export function parseDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, `${name} 应为 YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, `${name} 不是有效日期`);
  }
  return value;
}

export function optionalDate(
  parameters: URLSearchParams,
  name: string,
): string | undefined {
  const value = parameters.get(name);
  return value === null || value === "" ? undefined : parseDate(value, name);
}

export function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
