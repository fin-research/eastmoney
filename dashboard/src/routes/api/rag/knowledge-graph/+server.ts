import {
  GRAPH_WINDOW_DAYS,
  loadKnowledgeGraph,
  shanghaiDate,
} from "$lib/server/knowledge-graph";
import type { RequestHandler } from "./$types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env.DB) return fail(503, "D1 未配置");

  const end = url.searchParams.get("end") ?? shanghaiDate(new Date());
  if (!DATE.test(end) || Number.isNaN(Date.parse(`${end}T00:00:00Z`))) {
    return fail(400, "end 必须是有效的 YYYY-MM-DD");
  }
  const days = Number(url.searchParams.get("days") ?? 14);
  if (!(GRAPH_WINDOW_DAYS as readonly number[]).includes(days)) {
    return fail(400, `days 必须是 ${GRAPH_WINDOW_DAYS.join("、")} 之一`);
  }
  const focus = url.searchParams.get("focus")?.trim() || undefined;
  if (focus && focus.length > 40) return fail(400, "focus 不能超过 40 个字符");

  try {
    return Response.json(await loadKnowledgeGraph(platform.env.DB, { end, days, focus }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "knowledge_graph_failed",
      end,
      days,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }));
    return fail(500, "传导图读取失败，请稍后重试");
  }
};
