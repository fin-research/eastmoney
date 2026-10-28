import { generateCommentarySchema } from "$lib/commentary";
import { generateCommentary } from "$lib/server/commentary-generation";
import { getCommentary } from "$lib/server/commentary-repository";
import { validateSameOrigin } from "$lib/server/bond-ledger";
import { requireCommentaryEnv, commentaryError } from "$lib/server/commentary-http";
import { PolicyRepositoryError } from "$lib/server/policy-repository";
import { createAiSseResponse } from "$lib/server/ai-sse";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ platform, params, request }) => {
  try {
    validateSameOrigin(request);
    const env = requireCommentaryEnv(platform), input = generateCommentarySchema.parse(await request.json());
    await getCommentary(env.DB, params.id);
    return createAiSseResponse(
      request,
      ({ signal, progress }) => generateCommentary(env, params.id, input, () => {}, signal, progress),
      {
        errorMessage: (error) => error instanceof PolicyRepositoryError && error.status < 500
          ? error.message
          : "点评生成失败，请稍后重试",
        onError: (error) => console.error(JSON.stringify({
          event: "commentary_generation_failed",
          commentary_id: params.id,
          error: error instanceof Error ? error.message : String(error),
        })),
      },
    );
  } catch (error) { return commentaryError(error); }
};
