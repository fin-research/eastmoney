import {
  archiveFundReportRequest,
  FundReportError,
} from "$lib/server/fund-report";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, url }) => {
  try {
    const result = await archiveFundReportRequest(
      request,
      platform?.env.EASTMONEY,
    );
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof FundReportError ? error.status : 500;
    console.error(
      JSON.stringify({
        event: "fund_report_upload_failed",
        status,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      {
        error:
          error instanceof FundReportError
            ? error.message
            : "资金日报上传失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
