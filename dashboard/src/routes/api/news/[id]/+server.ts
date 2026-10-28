import {
  loadPolicyNewsDetail,
  PolicyRepositoryError,
} from "$lib/server/policy-repository";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform, url }) => {
  try {
    if (!platform?.env.DB) throw new PolicyRepositoryError(503, "D1 未配置");
    const detail = await loadPolicyNewsDetail(platform.env.DB, params.id);
    return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof PolicyRepositoryError ? error.status : 500;
    console.error(JSON.stringify({
      event: "policy_news_detail_failed",
      status,
      path: url.pathname,
      sentiment_id: params.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      {
        error: error instanceof PolicyRepositoryError
          ? error.message
          : "新闻资讯读取失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
