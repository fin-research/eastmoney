import {
  fundReportDateFromFileName,
  fundReportFileName,
  fundReportObjectKey,
  MAX_FUND_REPORT_BYTES,
  type FundReportListItem,
} from "../fund-report.ts";
import {
  BondLedgerUploadError,
  validateSameOrigin,
} from "./bond-ledger.ts";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export class FundReportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FundReportError";
    this.status = status;
  }
}

export interface FundReportUploadResponse {
  stored: true;
  date: string;
  fileName: string;
  url: string;
  key: string;
  size: number;
  etag: string | null;
  uploadedAt: string;
  replaced: boolean;
}

type FundReportBucket = Env["EASTMONEY"];
type StoredFundReport = Exclude<
  Awaited<ReturnType<FundReportBucket["get"]>>,
  null
>;

export async function archiveFundReportRequest(
  request: Request,
  bucket: FundReportBucket | undefined,
): Promise<FundReportUploadResponse> {
  try {
    validateSameOrigin(request);
  } catch (error) {
    if (error instanceof BondLedgerUploadError) {
      throw new FundReportError(error.status, "仅允许从本站管理资金日报");
    }
    throw error;
  }

  const storage = requireFundReportBucket(bucket);
  const { fileName: originalName, reportDate, size } =
    validateUploadMetadata(request);
  const bytes = await readUploadBytes(request, size);
  validateHtmlDocument(bytes);

  const key = fundReportObjectKey(reportDate);
  const replaced = (await storage.head(key)) !== null;
  const uploadedAt = new Date().toISOString();
  const object = await storage.put(key, bytes, {
    httpMetadata: {
      contentType: HTML_CONTENT_TYPE,
      contentDisposition: `inline; filename="${fundReportFileName(reportDate)}"`,
      cacheControl: "public, max-age=300",
    },
    customMetadata: {
      originalName,
      reportDate,
      uploadedAt,
    },
  });
  if (!object) {
    throw new FundReportError(503, "资金日报写入 R2 失败");
  }

  return {
    stored: true,
    date: reportDate,
    fileName: fundReportFileName(reportDate),
    url: `/fund-report/${fundReportFileName(reportDate)}`,
    key,
    size: object.size,
    etag: object.etag || null,
    uploadedAt,
    replaced,
  };
}

export async function getFundReport(
  bucket: FundReportBucket | undefined,
  date: string,
): Promise<StoredFundReport> {
  const object = await requireFundReportBucket(bucket).get(
    fundReportObjectKey(date),
  );
  if (!object || !("body" in object)) {
    throw new FundReportError(404, `${date} 的资金日报尚未上传`);
  }
  return object;
}

export async function listFundReports(
  bucket: FundReportBucket | undefined,
): Promise<FundReportListItem[]> {
  const storage = requireFundReportBucket(bucket);
  const reports = new Map<string, FundReportListItem>();
  let cursor: string | undefined;

  do {
    const result = await storage.list({
      prefix: "fund-reports/",
      cursor,
    });
    for (const object of result.objects) {
      const fileName = object.key.slice("fund-reports/".length);
      const date = fundReportDateFromFileName(fileName);
      if (!date || object.key !== fundReportObjectKey(date)) continue;

      reports.set(date, {
        date,
        url: `/fund-report/${fundReportFileName(date)}`,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
      });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return [...reports.values()].sort((left, right) =>
    right.date.localeCompare(left.date),
  );
}

export function fundReportHeaders(
  object: StoredFundReport,
  date: string,
): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", HTML_CONTENT_TYPE);
  headers.set(
    "Content-Disposition",
    `inline; filename="${fundReportFileName(date)}"`,
  );
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("ETag", object.httpEtag);
  headers.set(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-downloads; frame-ancestors 'self'",
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function validateUploadMetadata(request: Request): {
  fileName: string;
  reportDate: string;
  size: number;
} {
  const encodedName = request.headers.get("X-Fund-Report-Filename") ?? "";
  let fileName = "";
  try {
    fileName = decodeURIComponent(encodedName).trim();
  } catch {
    throw new FundReportError(400, "资金日报文件名编码无效");
  }
  if (
    !fileName ||
    fileName.length > 180 ||
    /[\u0000-\u001f/\\]/.test(fileName)
  ) {
    throw new FundReportError(400, "资金日报文件名无效");
  }
  const reportDate = fundReportDateFromFileName(fileName);
  if (!reportDate) {
    throw new FundReportError(
      400,
      "文件名末尾必须包含有效日期，例如 资金日报驾驶舱交互版_20260824.html",
    );
  }

  const size = Number(request.headers.get("X-Fund-Report-Size"));
  if (!Number.isInteger(size) || size <= 0) {
    throw new FundReportError(400, "资金日报文件大小无效");
  }
  if (size > MAX_FUND_REPORT_BYTES) {
    throw new FundReportError(413, "资金日报文件不能超过 20 MB");
  }
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength !== size
    ) {
      throw new FundReportError(400, "资金日报文件大小与请求内容不一致");
    }
    if (contentLength > MAX_FUND_REPORT_BYTES) {
      throw new FundReportError(413, "资金日报文件不能超过 20 MB");
    }
  }
  const contentType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/octet-stream") {
    throw new FundReportError(415, "资金日报文件类型必须是 .html");
  }
  return { fileName, reportDate, size };
}

async function readUploadBytes(
  request: Request,
  declaredSize: number,
): Promise<ArrayBuffer> {
  if (!request.body) {
    throw new FundReportError(400, "资金日报文件内容为空");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FUND_REPORT_BYTES) {
      await reader.cancel();
      throw new FundReportError(413, "资金日报文件不能超过 20 MB");
    }
    if (total > declaredSize) {
      await reader.cancel();
      throw new FundReportError(400, "资金日报文件大小与请求内容不一致");
    }
    chunks.push(value);
  }
  if (total !== declaredSize) {
    throw new FundReportError(400, "资金日报文件大小与请求内容不一致");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function validateHtmlDocument(bytes: ArrayBuffer): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FundReportError(400, "资金日报必须使用 UTF-8 编码");
  }
  const opening = text.slice(0, 8192).replace(/^\uFEFF/, "").trimStart();
  if (!/^<!doctype\s+html\b/i.test(opening) && !/^<html\b/i.test(opening)) {
    throw new FundReportError(400, "文件内容不是完整的 HTML 页面");
  }
}

function requireFundReportBucket(
  bucket: FundReportBucket | undefined,
): FundReportBucket {
  if (!bucket) {
    throw new FundReportError(503, "R2 资金日报存储未配置");
  }
  return bucket;
}
