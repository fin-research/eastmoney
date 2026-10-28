import { loadIssuanceModelReport } from "$lib/server/issuance-model-repository";
import { z } from "zod";

import {
  FinancingModelDatabaseError,
} from "$lib/server/financing-model-repository";
import { withPostgres } from "$lib/server/postgres";
import type { RequestHandler } from "./$types";

const runIdSchema = z.string().uuid();

export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const runValue = url.searchParams.get("run");
    const runId = runValue === null ? null : runIdSchema.parse(runValue);
    const report = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-read",
      (client) => loadIssuanceModelReport(client, runId),
    );
    return Response.json(report, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return financingModelErrorResponse(error, "read", url.pathname);
  }
};

function financingModelErrorResponse(
  error: unknown,
  action: string,
  path: string,
): Response {
  const status =
    error instanceof FinancingModelDatabaseError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
  console.error(
    JSON.stringify({
      event: `financing_model_${action}_failed`,
      status,
      path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return Response.json(
    {
      error:
        error instanceof FinancingModelDatabaseError
          ? error.message
          : status === 400
            ? "融资择时模型运行 ID 无效"
            : "融资择时模型读取失败，请稍后重试",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
