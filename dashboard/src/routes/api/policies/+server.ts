import { z } from "zod";

import { policyCategorySchema } from "$lib/policies";
import {
  loadPolicyTimeline,
  PolicyRepositoryError,
} from "$lib/server/policy-repository";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  if (!platform?.env.DB) {
    return Response.json({ error: "D1 未配置" }, { status: 503 });
  }
  try {
    const startDate = optionalDate(url.searchParams.get("startDate"), "startDate");
    const endDate = optionalDate(url.searchParams.get("endDate"), "endDate");
    if (startDate && endDate && startDate > endDate) {
      throw new PolicyRepositoryError(400, "startDate 不能晚于 endDate");
    }
    const rawCategory = url.searchParams.get("category")?.trim() || undefined;
    const category = rawCategory ? policyCategorySchema.parse(rawCategory) : undefined;
    const policies = await loadPolicyTimeline(platform.env.DB, {
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(category ? { category } : {}),
    });
    return Response.json({ policies }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof PolicyRepositoryError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
    console.error(JSON.stringify({
      event: "policy_timeline_failed",
      status,
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      {
        error: error instanceof PolicyRepositoryError
          ? error.message
          : status === 400
            ? "政策筛选参数无效"
            : "政策时间轴读取失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

function optionalDate(value: string | null, field: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || !parsed.toISOString().startsWith(value)) {
    throw new PolicyRepositoryError(400, `${field} 必须是有效的 YYYY-MM-DD`);
  }
  return value;
}
