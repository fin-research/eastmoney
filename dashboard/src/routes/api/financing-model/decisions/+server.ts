import { z } from "zod";

import { timingDecisionInputSchema } from "$lib/financing-model";
import { BondLedgerUploadError, validateSameOrigin } from "$lib/server/bond-ledger";
import {
  FinancingModelDatabaseError,
  loadTimingDecisionHistory,
  saveTimingDecisionRecord,
} from "$lib/server/financing-model-repository";
import { withPostgres } from "$lib/server/postgres";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const history = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-decisions-read",
      loadTimingDecisionHistory,
    );
    return Response.json(history, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return decisionErrorResponse(error, "read", url.pathname);
  }
};

export const POST: RequestHandler = async ({ request, platform, url }) => {
  try {
    validateSameOrigin(request);
    const input = timingDecisionInputSchema.parse(await request.json());
    const record = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-decisions-save",
      (client) => saveTimingDecisionRecord(client, input),
    );
    return Response.json(record, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return decisionErrorResponse(error, "save", url.pathname);
  }
};

function decisionErrorResponse(
  error: unknown,
  action: "read" | "save",
  path: string,
): Response {
  const status =
    error instanceof BondLedgerUploadError ||
    error instanceof FinancingModelDatabaseError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
  console.error(
    JSON.stringify({
      event: `financing_model_decisions_${action}_failed`,
      status,
      path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return Response.json(
    {
      error:
        error instanceof BondLedgerUploadError ||
        error instanceof FinancingModelDatabaseError
          ? error.message
          : status === 400
            ? "择时决策记录内容无效"
            : action === "read"
              ? "择时决策记录读取失败，请稍后重试"
              : "择时决策记录保存失败，请稍后重试",
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
