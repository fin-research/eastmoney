import { z } from "zod";
import { commentaryTypeSchema } from "$lib/commentary";
import { createCommentarySchema } from "$lib/commentary";
import { createCommentary, listCommentaries } from "$lib/server/commentary-repository";
import { validateSameOrigin } from "$lib/server/bond-ledger";
import { requireCommentaryEnv, commentaryError, commentaryHeaders } from "$lib/server/commentary-http";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ platform, url }) => {
  try {
    const query = z.object({ q: z.string().max(240).optional(), type: commentaryTypeSchema.optional(),
      offset: z.coerce.number().int().min(0).max(100000).default(0), policyId: z.string().max(240).optional() }).parse(Object.fromEntries(url.searchParams));
    return Response.json(await listCommentaries(requireCommentaryEnv(platform).DB, query), { headers: commentaryHeaders });
  } catch (error) { return commentaryError(error); }
};
export const POST: RequestHandler = async ({ platform, request }) => {
  try {
    validateSameOrigin(request);
    const input = createCommentarySchema.parse(await request.json());
    return Response.json(await createCommentary(requireCommentaryEnv(platform).DB, input), { status: 201, headers: commentaryHeaders });
  } catch (error) { return commentaryError(error); }
};
