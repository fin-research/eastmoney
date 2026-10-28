import {
  generateMarketHotspots,
  HotspotError,
  type HotspotRequestScope,
} from "$lib/server/hotspots";
import { loadLatestHotspotSnapshot } from "$lib/server/hotspot-snapshots";
import { createAiSseResponse } from "$lib/server/ai-sse";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform }) => {
  if (!platform?.env.DB) {
    return Response.json(
      { error: "D1 未配置" },
      { status: 503 },
    );
  }
  try {
    const result = await loadLatestHotspotSnapshot(platform.env.DB);
    if (!result) {
      throw new HotspotError(404, "尚无已生成的市场热点，请手动生成");
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof HotspotError ? error.status : 500;
    console.error(
      JSON.stringify({
        event: "market_hotspots_failed",
        action: "load_latest_snapshot",
        status,
        error: describeError(error),
      }),
    );
    return Response.json(
      { error: publicErrorMessage(error, status) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const POST: RequestHandler = async ({ platform, request }) => {
  if (
    !platform?.env.DB ||
    !platform.env.CLOUDFLARE_ACCOUNT_ID ||
    !platform.env.AI_GATEWAY_ID ||
    !platform.env.CF_AIG_TOKEN
  ) {
    return Response.json(
      { error: "D1 或 AI Gateway 配置未完成" },
      { status: 503 },
    );
  }
  let scope: HotspotRequestScope | null = null;
  try {
    scope = requestScope(await parseJsonBody(request));
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const env = platform.env;
      const currentScope = scope;
      return createAiSseResponse(
        request,
        ({ signal, progress }) => generateMarketHotspots(env, currentScope, { signal, onProgress: progress }),
        {
          errorMessage: (error) => publicErrorMessage(error, error instanceof HotspotError ? error.status : 500),
          onError: (error) => console.error(JSON.stringify({
            event: "market_hotspots_failed",
            action: "generate_snapshot",
            scope: scopeForLog(currentScope),
            status: error instanceof HotspotError ? error.status : 500,
            error: describeError(error),
          })),
        },
      );
    }
    const result = await generateMarketHotspots(platform.env, scope);
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof HotspotError ? error.status : 500;
    console.error(
      JSON.stringify({
        event: "market_hotspots_failed",
        action: "generate_snapshot",
        scope: scope ? scopeForLog(scope) : "invalid",
        status,
        error: describeError(error),
      }),
    );
    return Response.json(
      { error: publicErrorMessage(error, status) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function requestScope(value: unknown): HotspotRequestScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HotspotError(400, "请求体必须是证据范围对象");
  }
  const body = value as Record<string, unknown>;
  const mode = body.mode;
  if (mode === "rolling") {
    const rollingCount = Number(body.rollingCount);
    if (!Number.isInteger(rollingCount) || rollingCount < 8 || rollingCount > 100) {
      throw new HotspotError(400, "rollingCount 必须是 8-100 的整数");
    }
    return { mode: "rolling", rollingCount };
  }
  if (mode !== "range") {
    throw new HotspotError(400, "mode 必须是 rolling 或 range");
  }
  const startDate = typeof body.startDate === "string" ? body.startDate : "";
  const endDate = typeof body.endDate === "string" ? body.endDate : "";
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new HotspotError(400, "startDate 和 endDate 必须是有效的 YYYY-MM-DD");
  }
  if (startDate > endDate) {
    throw new HotspotError(400, "startDate 不能晚于 endDate");
  }
  return { mode: "range", startDate, endDate };
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HotspotError(400, "请求体必须是有效 JSON");
  }
}

function scopeForLog(scope: HotspotRequestScope): string {
  return scope.mode === "rolling"
    ? `rolling:${scope.rollingCount}`
    : `range:${scope.startDate}:${scope.endDate}`;
}

function describeError(error: unknown): Record<string, unknown> | string {
  if (!(error instanceof Error)) return String(error);
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack?.slice(0, 2_000),
  };
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key in details) continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      details[key] = value;
    }
  }
  return details;
}

function publicErrorMessage(error: unknown, status: number): string {
  if (error instanceof HotspotError) return error.message;
  if (status >= 500) return "市场热点生成失败，请稍后重试";
  return error instanceof Error ? error.message : String(error);
}
