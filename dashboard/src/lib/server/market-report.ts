import {
  marketReportObjectKey,
  marketReportSnapshotSchema,
  reportDataSchema,
  type MarketReportSnapshotContract,
  type ReportDataContract,
} from "../../market-report.ts";

export class MarketReportStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: string;
  readonly stage: string;

  constructor(
    status: number,
    message: string,
    code: string,
    stage: string,
    source = "Dashboard R2",
  ) {
    super(message);
    this.name = "MarketReportStoreError";
    this.status = status;
    this.code = code;
    this.source = source;
    this.stage = stage;
  }
}

type EastmoneyBucket = Env["EASTMONEY"];
const MAX_MARKET_REPORT_BYTES = 512 * 1024;

export async function readMarketReport(
  bucket: EastmoneyBucket | undefined,
  reportDate: string,
): Promise<MarketReportSnapshotContract> {
  const storage = requireBucket(bucket);
  const key = marketReportObjectKey(reportDate);
  const object = await storage.get(key);
  if (!object) {
    throw new MarketReportStoreError(
      404,
      `${reportDate} 尚无市场点评定稿`,
      "REPORT_NOT_FINALIZED",
      "snapshot_read",
    );
  }
  if (object.size > MAX_MARKET_REPORT_BYTES) {
    await object.body.cancel();
    throw new MarketReportStoreError(
      503,
      `${reportDate} 市场点评定稿数据过大`,
      "FINALIZED_SNAPSHOT_TOO_LARGE",
      "snapshot_validation",
    );
  }
  try {
    const snapshot = marketReportSnapshotSchema.parse(await object.json());
    if (snapshot.report_date !== reportDate) throw new Error("报告日期不匹配");
    if (!snapshot.finalized_at) throw new MarketReportStoreError(404, `${reportDate} 尚无市场点评定稿`, "REPORT_NOT_FINALIZED", "snapshot_read");
    return snapshot;
  } catch (error) {
    if (error instanceof MarketReportStoreError) throw error;
    console.error(JSON.stringify({
      event: "market_report_snapshot_invalid",
      reportDate,
      key,
    }));
    throw new MarketReportStoreError(
      503,
      `${reportDate} 市场点评定稿数据损坏`,
      "FINALIZED_SNAPSHOT_INVALID",
      "snapshot_validation",
    );
  }
}

export async function saveMarketReport(
  bucket: EastmoneyBucket | undefined,
  reportDate: string,
  report: unknown,
  focusText: unknown,
): Promise<MarketReportSnapshotContract> {
  const storage = requireBucket(bucket);
  let parsedReport: ReportDataContract;
  try {
    parsedReport = reportDataSchema.parse(report);
  } catch {
    throw new MarketReportStoreError(
      400,
      "市场点评定稿数据不符合规范契约",
      "INVALID_REPORT_SNAPSHOT",
      "request_validation",
      "Dashboard API",
    );
  }
  if (parsedReport.report_date !== reportDate) {
    throw new MarketReportStoreError(
      400,
      "报告日期与保存日期不一致",
      "REPORT_DATE_MISMATCH",
      "request_validation",
      "Dashboard API",
    );
  }
  if (typeof focusText !== "string") {
    throw new MarketReportStoreError(
      400,
      "今日聚焦内容无效",
      "INVALID_FOCUS_TEXT",
      "request_validation",
      "Dashboard API",
    );
  }
  const now = new Date().toISOString();
  const snapshot = marketReportSnapshotSchema.parse({
    ...parsedReport,
    focus_text: focusText,
    cached_at: now,
    finalized_at: now,
  });
  await writeSnapshot(storage, marketReportObjectKey(reportDate), snapshot);
  return snapshot;
}

async function writeSnapshot(
  bucket: EastmoneyBucket,
  key: string,
  snapshot: MarketReportSnapshotContract,
): Promise<void> {
  const body = JSON.stringify(snapshot);
  if (new TextEncoder().encode(body).byteLength > MAX_MARKET_REPORT_BYTES) {
    throw new MarketReportStoreError(
      400,
      "市场点评定稿数据过大，请裁剪后重试",
      "FINALIZED_SNAPSHOT_TOO_LARGE",
      "snapshot_validation",
    );
  }
  const object = await bucket.put(key, body, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
    },
    customMetadata: {
      reportDate: snapshot.report_date,
      cachedAt: snapshot.cached_at,
      ...(snapshot.finalized_at ? { finalizedAt: snapshot.finalized_at } : {}),
    },
  });
  if (!object) {
    throw new MarketReportStoreError(
      503,
      "市场点评写入 R2 失败",
      "R2_WRITE_FAILED",
      "snapshot_write",
    );
  }
}

function requireBucket(bucket: EastmoneyBucket | undefined): EastmoneyBucket {
  if (!bucket) {
    throw new MarketReportStoreError(
      503,
      "East Money R2 未配置",
      "R2_NOT_CONFIGURED",
      "binding_access",
    );
  }
  return bucket;
}
