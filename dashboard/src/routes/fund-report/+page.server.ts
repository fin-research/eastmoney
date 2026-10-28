import {
  FundReportError,
  listFundReports,
} from "$lib/server/fund-report";
import { currentReportDate } from "../../report-date";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform, setHeaders, depends }) => {
  depends("app:fund-reports");
  setHeaders({ "Cache-Control": "no-store" });

  try {
    return {
      reports: await listFundReports(platform?.env.EASTMONEY),
      today: currentReportDate(),
      loadError: null,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "fund_report_list_failed",
        status: error instanceof FundReportError ? error.status : 500,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      reports: [],
      today: currentReportDate(),
      loadError: "资金日报列表暂时无法读取，请稍后重试",
    };
  }
};
