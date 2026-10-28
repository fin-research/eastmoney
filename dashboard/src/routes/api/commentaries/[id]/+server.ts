import { updateCommentarySchema } from "$lib/commentary";
import { getCommentary, updateCommentary } from "$lib/server/commentary-repository";
import { validateSameOrigin } from "$lib/server/bond-ledger";
import { requireCommentaryEnv, commentaryError, commentaryHeaders } from "$lib/server/commentary-http";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ platform, params }) => {
  try { return Response.json(await getCommentary(requireCommentaryEnv(platform).DB, params.id), { headers: commentaryHeaders }); }
  catch (error) { return commentaryError(error); }
};
export const PUT: RequestHandler = async ({ platform, params, request }) => {
  try {
    validateSameOrigin(request);
    const { updatedAt, ...input } = updateCommentarySchema.parse(await request.json());
    return Response.json(await updateCommentary(requireCommentaryEnv(platform).DB, params.id, input, updatedAt), { headers: commentaryHeaders });
  } catch (error) { return commentaryError(error); }
};
