import { resolveDefaultReportDate } from "$lib/server/market-report-date";
import {
  MarketReportStoreError,
  readMarketReport,
  saveMarketReport,
} from "$lib/server/market-report";
import { validateSameOrigin } from "$lib/server/bond-ledger";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const reportDate = url.searchParams.has("date") ? requiredDate(url) : await resolveDefaultReportDate(platform?.env);
    const snapshot = await readMarketReport(platform?.env.EASTMONEY, reportDate);
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, url, "read");
  }
};

export const PUT: RequestHandler = async ({ request, platform, url }) => {
  try {
    validateSameOrigin(request);
    const reportDate = requiredDate(url);
    const payload = (await request.json()) as { report?: unknown; focusText?: unknown };
    const snapshot = await saveMarketReport(
      platform?.env.EASTMONEY,
      reportDate,
      payload.report,
      payload.focusText,
    );
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, url, "save");
  }
};

function requiredDate(url: URL): string {
  const value = url.searchParams.get("date") ?? "";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    !parsed.toISOString().startsWith(value)
  ) {
    throw new MarketReportStoreError(
      400,
      "报告日期必须是 YYYY-MM-DD",
      "INVALID_REPORT_DATE",
      "request_validation",
      "Dashboard API",
    );
  }
  return value;
}

function errorResponse(error: unknown, url: URL, action: string): Response {
  const status = error instanceof MarketReportStoreError ? error.status : 500;
  if (status !== 404) {
    console.error(
      JSON.stringify({
        event: `market_report_${action}_failed`,
        status,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return Response.json(
    {
      detail: error instanceof MarketReportStoreError
        ? error.message
        : "市场点评处理失败，请稍后重试",
      error: error instanceof MarketReportStoreError
        ? {
            code: error.code,
            source: error.source,
            stage: error.stage,
          }
        : {
            code: "UNEXPECTED_ERROR",
            source: "Dashboard API",
            stage: `snapshot_${action}`,
          },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
