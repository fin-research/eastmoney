import { z } from "zod";

import { articleAssociationUpdateSchema } from "$lib/policies";
import { BondLedgerUploadError, validateSameOrigin } from "$lib/server/bond-ledger";
import {
  PolicyRepositoryError,
  saveManualPolicyArticles,
} from "$lib/server/policy-repository";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, params, platform, url }) => {
  try {
    validateSameOrigin(request);
    if (!platform?.env.DB) throw new PolicyRepositoryError(503, "D1 未配置");
    const input = articleAssociationUpdateSchema.parse(await request.json());
    await saveManualPolicyArticles(platform.env.DB, params.id, input.articleIds);
    return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof BondLedgerUploadError || error instanceof PolicyRepositoryError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
    console.error(JSON.stringify({
      event: "policy_article_update_failed",
      status,
      path: url.pathname,
      policy_id: params.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      {
        error:
          error instanceof BondLedgerUploadError || error instanceof PolicyRepositoryError
            ? error.message
            : status === 400
              ? "研报关联请求无效"
              : "研报关联保存失败，请稍后重试",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
};
