import { z } from "zod";

import { conclusionUpdateSchema } from "$lib/financing-model";
import { BondLedgerUploadError, validateSameOrigin } from "$lib/server/bond-ledger";
import {
  FinancingModelDatabaseError,
  saveFinancingModelConclusion,
} from "$lib/server/financing-model-repository";
import { withPostgres } from "$lib/server/postgres";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async ({ request, platform, url }) => {
  try {
    validateSameOrigin(request);
    const input = conclusionUpdateSchema.parse(await request.json());
    const conclusion = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-conclusion",
      (client) => saveFinancingModelConclusion(client, input),
    );
    return Response.json(conclusion, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status =
      error instanceof BondLedgerUploadError ||
      error instanceof FinancingModelDatabaseError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    console.error(
      JSON.stringify({
        event: "financing_model_conclusion_failed",
        status,
        path: url.pathname,
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
              ? "整体结论内容无效"
              : "整体结论保存失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
