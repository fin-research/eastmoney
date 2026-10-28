import { DataNewsError, fetchDataNewsDetail } from "$lib/server/data-news";
import {
  loadResearchReportMetadata,
  PolicyRepositoryError,
} from "$lib/server/policy-repository";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform, url }) => {
  try {
    const env = platform?.env;
    if (!env?.DB) throw new PolicyRepositoryError(503, "D1 未配置");
    const metadata = await loadResearchReportMetadata(env.DB, params.id);
    const detail = await fetchDataNewsDetail(env, params.id);
    return Response.json({
      ...metadata,
      content: detail.content,
      link: detail.link ?? metadata.link,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof PolicyRepositoryError || error instanceof DataNewsError
      ? error.status
      : 500;
    console.error(JSON.stringify({
      event: "research_report_detail_failed",
      status,
      path: url.pathname,
      article_id: params.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      {
        error: error instanceof PolicyRepositoryError || error instanceof DataNewsError
          ? error.message
          : "研报读取失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
