import { isFundReportDate } from "$lib/fund-report";
import {
  FundReportError,
  fundReportHeaders,
  getFundReport,
} from "$lib/server/fund-report";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform, url }) => {
  const date = params.date;
  if (!isFundReportDate(date)) {
    return new Response("资金日报日期必须是有效的 YYYY-MM-DD", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const object = await getFundReport(platform?.env.EASTMONEY, date);
    return new Response(object.body as BodyInit, {
      headers: fundReportHeaders(object, date),
    });
  } catch (error) {
    const status = error instanceof FundReportError ? error.status : 500;
    console.error(
      JSON.stringify({
        event: "fund_report_read_failed",
        status,
        path: url.pathname,
        reportDate: date,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(
      error instanceof FundReportError
        ? error.message
        : "资金日报读取失败，请稍后重试",
      {
        status,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
};
