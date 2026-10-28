import { commentaryRevisions } from "$lib/server/commentary-repository";
import { requireCommentaryEnv, commentaryError, commentaryHeaders } from "$lib/server/commentary-http";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ platform, params }) => {
  try { return Response.json({ revisions: await commentaryRevisions(requireCommentaryEnv(platform).DB, params.id) }, { headers: commentaryHeaders }); }
  catch (error) { return commentaryError(error); }
};
