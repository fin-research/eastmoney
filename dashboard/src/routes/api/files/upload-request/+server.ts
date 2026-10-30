import { z } from "zod";
import { BondLedgerUploadError, readBondLedgerJson } from "$lib/server/bond-ledger";
import { error, json } from "@sveltejs/kit";
import { hasPermission } from "$lib/permissions";
import { presignR2PutUrl } from "$lib/server/r2-presign";
import { UPLOAD_PURPOSES } from "$lib/server/upload-purposes";
import type { RequestHandler } from "./$types";

const UPLOAD_EXPIRES_SECONDS = 15 * 60;
const MAX_FILE_NAME = 180;
const uploadRequestSchema = z.object({
  purpose: z.literal("bond-ledger"), fileName: z.string().trim().min(1).max(MAX_FILE_NAME),
  size: z.number().int().positive(), contentType: z.string().min(1).max(120).regex(/^[^\r\n]+$/).optional(),
}).strict();
const UPLOAD_SCHEME_VERSION = 1;

export const POST: RequestHandler = async ({ request, locals, platform }) => {
  const env = platform?.env;
  const credentials = {
    accessKeyId: env?.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY ?? "",
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !env?.CLOUDFLARE_ACCOUNT_ID) {
    throw error(503, "文件直传服务未配置");
  }
  let body: unknown;
  try { body = await readBondLedgerJson(request, 4096); }
  catch (cause) { throw error(cause instanceof BondLedgerUploadError ? cause.status : 400, "上传申请内容无效"); }
  const decoded = uploadRequestSchema.safeParse(body);
  if (!decoded.success) throw error(400, "上传申请内容无效");
  const values = decoded.data;
  const purposeName = typeof values.purpose === "string" ? values.purpose : "";
  const purpose = UPLOAD_PURPOSES[purposeName as keyof typeof UPLOAD_PURPOSES];
  if (!purpose) throw error(400, "上传用途未登记");
  if (!locals.user?.authorization || !hasPermission(locals.permissions, purpose.permission)) {
    throw error(403, "当前角色无权上传该用途文件");
  }
  const fileName = typeof values.fileName === "string" ? values.fileName.trim() : "";
  if (!fileName || fileName.length > MAX_FILE_NAME || /[\u0000-\u001f/\\]/.test(fileName)) {
    throw error(400, "文件名无效");
  }
  const extension = purpose.extensions.find((candidate) => fileName.toLowerCase().endsWith(candidate)) ?? null;
  if (!extension) throw error(400, `该用途仅支持 ${purpose.extensions.join("、")} 文件`);
  const size = typeof values.size === "number" && Number.isInteger(values.size) ? values.size : 0;
  if (size <= 0 || size > purpose.maxBytes) {
    throw error(400, `文件大小须在 1 字节至 ${purpose.maxBytes} 字节之间`);
  }
  const contentType = typeof values.contentType === "string" && values.contentType ? values.contentType : purpose.contentType;
  const uploadId = crypto.randomUUID();
  const key = `${purpose.prefix}${uploadId}${extension}`;
  const { url, expiresAt, requiredHeaders } = await presignR2PutUrl(
    credentials,
    env.CLOUDFLARE_ACCOUNT_ID,
    purpose.bucketName,
    key,
    contentType,
    UPLOAD_EXPIRES_SECONDS,
  );
  return json({
    version: UPLOAD_SCHEME_VERSION,
    purpose: purposeName,
    uploadId,
    key,
    uploadUrl: url,
    requiredHeaders,
    expiresAt,
    sizeLimit: purpose.maxBytes,
    contentType,
  });
};
