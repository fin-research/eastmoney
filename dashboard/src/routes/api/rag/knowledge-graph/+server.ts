import {
  GRAPH_MAX_DAYS,
  loadKnowledgeGraph,
  shanghaiDate,
} from "$lib/server/knowledge-graph";
import type { RequestHandler } from "./$types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function validDate(value: string): boolean {
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env.DB) return fail(503, "D1 未配置");

  const end = url.searchParams.get("end") ?? shanghaiDate(new Date());
  if (!validDate(end)) return fail(400, "end 必须是有效的 YYYY-MM-DD");

  // `start` wins over `days`; both describe the same inclusive window ending at `end`.
  const start = url.searchParams.get("start");
  let days = Number(url.searchParams.get("days") ?? 14);
  if (start !== null) {
    if (!validDate(start)) return fail(400, "start 必须是有效的 YYYY-MM-DD");
    days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  }
  if (!Number.isInteger(days) || days < 1 || days > GRAPH_MAX_DAYS) {
    return fail(400, `时间范围必须在 1 到 ${GRAPH_MAX_DAYS} 天之间`);
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
