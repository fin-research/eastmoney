import { loadIssuanceModelReport, saveActiveIssuanceSellSide } from "$lib/server/issuance-model-repository";
import { z } from "zod";

import { sellSideSummaryUpdateSchema } from "$lib/financing-model";
import { BondLedgerUploadError, validateSameOrigin } from "$lib/server/bond-ledger";
import {
  FinancingModelDatabaseError,
  saveSellSideSummaryRevision,
} from "$lib/server/financing-model-repository";
import {
  FinancingModelResearchError,
  generateFinancingModelResearch,
} from "$lib/server/financing-model-research";
import { withPostgres } from "$lib/server/postgres";
import { createAiSseResponse } from "$lib/server/ai-sse";
import type { RequestHandler } from "./$types";

const requestSchema = z.object({ runId: z.string().uuid() }).strict();

export const POST: RequestHandler = async ({ request, platform, url }) => {
  try {
    validateSameOrigin(request);
    const { runId } = requestSchema.parse(await request.json());
    const env = platform?.env;
    if (
      !env?.CLOUDFLARE_ACCOUNT_ID ||
      !env.AI_GATEWAY_ID ||
      !env.CF_AIG_TOKEN
    ) {
      throw new FinancingModelResearchError(503, "AI Gateway 配置未完成");
    }
    const report = await withPostgres(
      env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-research-read",
      (client) => loadIssuanceModelReport(client, runId),
    );
    if (report.model_status.status !== 'active') {
      throw new FinancingModelResearchError(409, '数据不满足要求，暂停预测');
    }
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      return createAiSseResponse(
        request,
        async ({ signal, progress }) => {
          const research = await generateFinancingModelResearch(
            report.snapshot,
            {
              accountId: env.CLOUDFLARE_ACCOUNT_ID,
              gatewayId: env.AI_GATEWAY_ID || "default",
              token: env.CF_AIG_TOKEN,
            },
            fetch,
            { signal, onProgress: progress },
          );
          signal.throwIfAborted();
          return withPostgres(
            env.HYPERDRIVE?.connectionString,
            "eastmoney-financing-model-research-save",
            (client) => saveActiveIssuanceSellSide(client, report, research),
          );
        },
        {
          errorMessage: (error) => error instanceof FinancingModelResearchError || error instanceof FinancingModelDatabaseError
            ? error.message
            : "卖方观点生成失败，请稍后重试",
          onError: (error) => console.error(JSON.stringify({
            event: "financing_model_sell_side_failed",
            status: error instanceof FinancingModelResearchError || error instanceof FinancingModelDatabaseError ? error.status : 500,
            path: url.pathname,
            error: error instanceof Error ? error.message : String(error),
          })),
        },
      );
    }
    const research = await generateFinancingModelResearch(
      report.snapshot,
      {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        gatewayId: env.AI_GATEWAY_ID || "default",
        token: env.CF_AIG_TOKEN,
      },
    );
    const saved = await withPostgres(
      env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-research-save",
      (client) => saveActiveIssuanceSellSide(client, report, research),
    );
    return Response.json(saved, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status =
      error instanceof BondLedgerUploadError ||
      error instanceof FinancingModelDatabaseError ||
      error instanceof FinancingModelResearchError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    console.error(
      JSON.stringify({
        event: "financing_model_sell_side_failed",
        status,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      {
        error:
          error instanceof BondLedgerUploadError ||
          error instanceof FinancingModelDatabaseError ||
          error instanceof FinancingModelResearchError || error instanceof FinancingModelDatabaseError
            ? error.message
            : status === 400
              ? "卖方观点请求无效"
              : "卖方观点生成失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};

export const PATCH: RequestHandler = async ({ request, platform, url }) => {
  try {
    validateSameOrigin(request);
    const input = sellSideSummaryUpdateSchema.parse(await request.json());
    const saved = await withPostgres(
      platform?.env.HYPERDRIVE?.connectionString,
      "eastmoney-financing-model-research-revision",
      async (client) => {
        const report = await loadIssuanceModelReport(client, input.runId);
        if (!report.sellSide) {
          throw new FinancingModelDatabaseError(404, "尚未生成卖方观点");
        }
        return saveSellSideSummaryRevision(
          client,
          report.snapshot,
          report.sellSide,
          input,
        );
      },
    );
    return Response.json(saved, {
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
        event: "financing_model_sell_side_revision_failed",
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
              ? "卖方观点内容无效"
              : "卖方观点保存失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
