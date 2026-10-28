import { z } from "zod";
import { validateSameOrigin } from "$lib/server/bond-ledger";
import { requireCommentaryEnv, commentaryError, commentaryHeaders } from "$lib/server/commentary-http";
import { archiveCommentaryPdf, downloadCommentaryPdf, readUploadedCommentaryPdf } from "$lib/server/commentary-pdf";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ platform, params, url }) => {
  try { return await downloadCommentaryPdf(requireCommentaryEnv(platform),params.id,z.string().min(1).max(80).optional().parse(url.searchParams.get("revisionAt") ?? undefined)); }
  catch(error) { return commentaryError(error); }
};
export const POST: RequestHandler = async ({ platform, params, request, url }) => {
  try {
    validateSameOrigin(request);
    if (request.headers.get("content-type")?.split(";")[0] === "application/pdf") {
      const updatedAt=z.string().min(1).max(80).parse(url.searchParams.get("updatedAt"));
      const bytes=await readUploadedCommentaryPdf(request);
      return Response.json(await archiveCommentaryPdf(requireCommentaryEnv(platform),params.id,updatedAt,bytes),{headers:commentaryHeaders});
    }
    const { updatedAt } = z.object({updatedAt:z.string().min(1).max(80)}).strict().parse(await request.json());
    return Response.json(await archiveCommentaryPdf(requireCommentaryEnv(platform),params.id,updatedAt),{headers:commentaryHeaders});
  } catch(error) { return commentaryError(error); }
};
