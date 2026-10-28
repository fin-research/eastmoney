import {
  generateMarketBriefing,
  MarketBriefingError,
} from "$lib/server/market-briefing";
import { createAiSseResponse } from "$lib/server/ai-sse";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ platform, url, request }) => {
  if (
    !platform?.env.CLOUDFLARE_ACCOUNT_ID ||
    !platform.env.AI_GATEWAY_ID ||
    !platform.env.CF_AIG_TOKEN
  ) {
    return Response.json(
      { error: "AI Gateway 配置未完成" },
      { status: 503 },
    );
  }
  try {
    const reportDate = resolveDate(url);
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const env = platform.env;
      return createAiSseResponse(
        request,
        ({ signal, progress }) => generateMarketBriefing(env, reportDate, { signal, onProgress: progress }),
        {
          errorMessage: (error) => publicErrorMessage(error, 500),
          onError: (error) => console.error(JSON.stringify({
            event: "market_briefing_failed",
            date: reportDate,
            status: error instanceof MarketBriefingError ? error.status : 500,
            error: error instanceof Error ? error.message : String(error),
          })),
        },
      );
    }
    const result = await generateMarketBriefing(platform.env, reportDate, { signal: request.signal });
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof MarketBriefingError ? error.status : 500;
    console.error(
      JSON.stringify({
        event: "market_briefing_failed",
        date: url.searchParams.get("date") ?? "",
        status,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      { error: publicErrorMessage(error, status) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

function resolveDate(url: URL): string {
  const raw = url.searchParams.get("date") ?? "";
  if (!raw) return shanghaiToday();
  if (!isIsoDate(raw)) {
    throw new MarketBriefingError(400, "date 必须是有效的 YYYY-MM-DD");
  }
  return raw;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function publicErrorMessage(error: unknown, status: number): string {
  if (error instanceof MarketBriefingError) return error.message;
  if (status >= 500) return "市场聚焦生成失败，请稍后重试";
  return error instanceof Error ? error.message : String(error);
}
