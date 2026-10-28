import { z } from "zod";

const errorIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  receivedType: z.string(),
  receivedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const dataApiErrorSchema = z.object({
  detail: z.string().optional(),
  error: z.object({
    code: z.string(),
    source: z.string().optional(),
    stage: z.string().optional(),
    upstreamStatus: z.number().int().optional(),
    upstreamPath: z.string().optional(),
    issues: z.array(errorIssueSchema).optional(),
  }).optional(),
});

export function dataApiErrorCode(payload: unknown): string | undefined {
  const parsed = dataApiErrorSchema.safeParse(payload);
  return parsed.success ? parsed.data.error?.code : undefined;
}

function endpointPath(url: string): string {
  try {
    return new URL(url, "https://data.invalid").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export function formatDataApiError(
  url: string,
  status: number,
  payload: unknown,
): string {
  const parsed = dataApiErrorSchema.safeParse(payload);
  const endpoint = endpointPath(url);
  if (!parsed.success) return `${endpoint} 请求失败（HTTP ${status}，错误响应格式无效）`;

  const detail = parsed.data.detail || "数据接口请求失败";
  const diagnostic = parsed.data.error;
  const context = diagnostic
    ? [
        diagnostic.code,
        diagnostic.source,
        diagnostic.stage,
        diagnostic.upstreamStatus === undefined
          ? undefined
          : `上游 HTTP ${diagnostic.upstreamStatus}`,
        diagnostic.upstreamPath,
      ].filter(Boolean).join(" / ")
    : "";
  const issues = diagnostic?.issues?.map((issue) => {
    const received = issue.receivedValue === undefined
      ? issue.receivedType
      : `${issue.receivedType} ${JSON.stringify(issue.receivedValue)}`;
    return `${issue.path || "<root>"}: ${issue.code}（收到 ${received}）`;
  }).join("；");
  return [
    `${endpoint} 请求失败（HTTP ${status}）：${detail}`,
    context,
    issues,
  ].filter(Boolean).join("；");
}

export class DataApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "DataApiRequestError";
    this.status = status;
    this.code = code;
  }
}
