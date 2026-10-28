import { parsedBondLedgerSchema } from "../bond-ledger/import-schema.ts";
import type { PersistBondLedgerInput, PersistBondLedgerResult, FailedBondLedgerInput } from "./bond-ledger-repository.ts";
import type { RemoteBondLedgerFile } from "./bond-ledger-repository.ts";

import { MAX_LEDGER_BYTES, MAX_PARSED_LEDGER_BYTES, MAX_IMPORT_REQUEST_BYTES } from "../bond-ledger/import-limits.ts";
const IMPORT_LEDGER_PREFIX = "bond-ledger/imports/";
const LEDGER_PREFIX = "bond-ledger/";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export class BondLedgerUploadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BondLedgerUploadError";
    this.status = status;
  }
}

type StoredBondLedger = Exclude<
  Awaited<ReturnType<Env["EASTMONEY"]["get"]>>,
  null
>;

export async function archiveBondLedgerRequest(
  request: Request,
  bucket: Env["EASTMONEY"] | undefined,
  persist: (input: PersistBondLedgerInput) => Promise<PersistBondLedgerResult>,
  recordFailure?: (input: FailedBondLedgerInput) => Promise<void>,
): Promise<PersistBondLedgerResult> {
  validateSameOrigin(request);
  const storage = requireBucket(bucket);
  if (!(request.headers.get("Content-Type") ?? "").startsWith("multipart/form-data;")) {
    throw new BondLedgerUploadError(415, "请刷新页面后重新上传台账");
  }
  const bytes = await readUploadBody(request);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("Content-Type")! } }).formData(); }
  catch { throw new BondLedgerUploadError(400, "台账上传内容无效"); }
  const file = form.get("file");
  if (!file || typeof file === "string" || !file.size || file.size > MAX_LEDGER_BYTES) {
    throw new BondLedgerUploadError(400, "台账文件必须为非空且不超过 12 MB 的 .xlsx");
  }
  const fileName = file.name.trim();
  if (!fileName || fileName.length > 180 || !fileName.toLowerCase().endsWith(".xlsx") || /[\u0000-\u001f/\\]/.test(fileName)) {
    throw new BondLedgerUploadError(400, "台账文件名无效，仅支持 .xlsx");
  }
  const rawParsed = form.get("parsed");
  let decoded: unknown;
  try {
    if (typeof rawParsed !== "string" || new TextEncoder().encode(rawParsed).byteLength > MAX_PARSED_LEDGER_BYTES) throw new Error();
    decoded = JSON.parse(rawParsed);
  } catch { throw new BondLedgerUploadError(400, "台账解析数据无效"); }
  const validated = parsedBondLedgerSchema.safeParse(decoded);
  if (!validated.success) throw new BondLedgerUploadError(400, "台账解析数据不符合导入要求");
  const parsed = validated.data;
  const expectedValue = form.get("expectedDate");
  if (expectedValue !== null && typeof expectedValue !== "string") throw new BondLedgerUploadError(400, "台账日期无效");
  const expectedDate = expectedValue || null;
  if (expectedDate) {
    validateLedgerDate(expectedDate);
    if (parsed.date !== expectedDate) throw new BondLedgerUploadError(400, `重新上传文件的报表日必须为 ${expectedDate}，实际为 ${parsed.date}`);
  }
  const uploadId = crypto.randomUUID();
  const uploadedAt = new Date().toISOString();
  // Immutable originals keep a concurrent replacement from changing the file of a committed import.
  const key = `${IMPORT_LEDGER_PREFIX}${uploadId}.xlsx`;
  const object = await storage.put(key, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: XLSX_CONTENT_TYPE,
      contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      cacheControl: "private, no-store",
    },
    customMetadata: { uploadId, originalName: fileName, uploadedAt, reportDate: parsed.date },
  });
  if (!object) throw new BondLedgerUploadError(503, "Excel 写入 R2 失败");
  // Keep the immutable original if COMMIT's response is lost; never delete a possibly committed file.
  const input = { uploadId, r2Key: key, r2Etag: object.etag || null,
    originalName: fileName, fileSize: file.size, expectedDate, uploadedAt, parsed };
  try { return await persist(input); }
  catch (error) {
    try { await recordFailure?.({ ...input, errorMessage: "直接导入失败，请核对数据库状态后重试" }); }
    catch { console.error(JSON.stringify({ event: "bond_ledger_failure_record_failed", uploadId, key })); }
    throw error;
  }
}

async function readUploadBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) throw new BondLedgerUploadError(400, "台账上传内容为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMPORT_REQUEST_BYTES) {
        await reader.cancel();
        throw new BondLedgerUploadError(413, "台账上传内容不能超过 21 MB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function getBondLedgerFile(
  bucket: Env["EASTMONEY"] | undefined,
  file: RemoteBondLedgerFile,
): Promise<StoredBondLedger> {
  const object = await requireBucket(bucket).get(file.key);
  if (!object) {
    throw new BondLedgerUploadError(404, `${file.date} 的 R2 原始台账不存在`);
  }
  return object;
}

export function ledgerDownloadHeaders(
  object: StoredBondLedger,
  fileName: string,
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", XLSX_CONTENT_TYPE);
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function validateSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new BondLedgerUploadError(403, "仅允许从本站管理台账");
  }
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new BondLedgerUploadError(403, "不允许跨站管理台账");
  }
}

export function validateLedgerDate(date: string): void {
  if (!isIsoDate(date)) {
    throw new BondLedgerUploadError(400, "台账日期必须是有效的 YYYY-MM-DD");
  }
}

export function bondLedgerObjectKey(reportDate: string): string {
  validateLedgerDate(reportDate);
  return `${LEDGER_PREFIX}${reportDate}.xlsx`;
}

function requireBucket(
  bucket: Env["EASTMONEY"] | undefined,
): Env["EASTMONEY"] {
  if (!bucket) {
    throw new BondLedgerUploadError(503, "R2 台账存储未配置");
  }
  return bucket;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}
