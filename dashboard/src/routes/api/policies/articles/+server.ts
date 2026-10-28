import { searchPolicyArticles } from "$lib/server/policy-repository";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env.DB) {
    return Response.json({ error: "D1 未配置" }, { status: 503 });
  }
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query.length > 120) {
    return Response.json({ error: "研报检索词不能超过 120 字" }, { status: 400 });
  }
  try {
    const articles = await searchPolicyArticles(platform.env.DB, query);
    return Response.json({ articles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({
      event: "policy_article_search_failed",
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "研报检索失败，请稍后重试" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
