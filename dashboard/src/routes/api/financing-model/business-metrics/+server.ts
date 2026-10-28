import { z } from "zod";

import { issuanceBusinessMetricsSchema } from "$lib/issuance-model";
import { FinancingModelDatabaseError } from "$lib/server/financing-model-repository";
import { loadIssuanceBusinessMetrics } from "$lib/server/issuance-business-metrics";
import { loadIssuanceModelMetricSource } from "$lib/server/issuance-model-repository";
import { withPostgres } from "$lib/server/postgres";
import type { RequestHandler } from "./$types";

const runIdSchema = z.string().uuid();

export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const runId = runIdSchema.parse(url.searchParams.get("run"));
    const metrics = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-business-metrics",
      async (client) => {
        const source = await loadIssuanceModelMetricSource(client, runId);
        return loadIssuanceBusinessMetrics(client, source.issuer, source.marketDate);
      },
    );
    return Response.json(issuanceBusinessMetricsSchema.parse(metrics), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof FinancingModelDatabaseError
      ? error.status
      : error instanceof z.ZodError ? 400 : 500;
    console.error(JSON.stringify({
      event: "financing_model_business_metrics_read_failed",
      status,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({
      error: error instanceof FinancingModelDatabaseError
        ? error.message
        : status === 400 ? "融资择时模型运行 ID 无效" : "业务指标读取失败，请稍后重试",
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
};
