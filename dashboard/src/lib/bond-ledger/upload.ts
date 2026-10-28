import type { BondLedgerReport, ParsedBondLedger } from "./types";

import { MAX_LEDGER_BYTES, MAX_PARSED_LEDGER_BYTES } from "./import-limits";

const LEDGER_ENDPOINT = "/api/bond-ledger";
export interface BondLedgerImportResult {
  reportDate: string;
  statisticsCount: number;
  positionCount: number;
  transactionCount: number;
}

export interface RemoteBondLedgerFile {
  date: string;
  fileName: string;
  key: string;
  size: number;
  etag: string;
  uploadedAt: string;
}

export interface BondLedgerInventory {
  files: RemoteBondLedgerFile[];
  databaseDates: string[];
  availableStartDate: string | null;
  availableEndDate: string | null;
}

export async function archiveBondLedgerFile(
  file: File,
  expectedDate?: string,
): Promise<BondLedgerImportResult> {
  if (!file.name.toLowerCase().endsWith(".xlsx") || !file.size || file.size > MAX_LEDGER_BYTES) {
    throw new Error("请选择不超过 12 MB 的 .xlsx 台账");
  }
  const parsed = await parseLocally(file);
  if (expectedDate && parsed.date !== expectedDate) {
    throw new Error(`重新上传文件的报表日必须为 ${expectedDate}，实际为 ${parsed.date}`);
  }
  const body = new FormData();
  body.set("file", file);
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PARSED_LEDGER_BYTES) throw new Error("台账解析数据不能超过 8 MB");
  body.set("parsed", serialized);
  if (expectedDate) body.set("expectedDate", expectedDate);
  const response = await fetch(LEDGER_ENDPOINT, { method: "POST", body });
  const payload = await jsonPayload(response);
  if (!response.ok || !isImportResult(payload)) {
    throw new Error(errorFromPayload(payload, `台账导入失败（HTTP ${response.status}）`));
  }
  return payload;
}

function parseLocally(file: File): Promise<ParsedBondLedger> {
  const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.parsed);
    };
    worker.onerror = () => { worker.terminate(); reject(new Error("台账解析失败")); };
    worker.postMessage(file);
  });
}

export async function loadBondLedgerReport(
  startDate: string,
  endDate: string,
): Promise<BondLedgerReport> {
  const response = await fetch(
    `${LEDGER_ENDPOINT}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`,
    { cache: "no-store" },
  );
  const payload = await jsonPayload(response);
  if (!response.ok || !isBondLedgerReport(payload)) {
    throw new Error(
      errorFromPayload(payload, `周报数据读取失败（HTTP ${response.status}）`),
    );
  }
  return payload;
}

export async function listRemoteBondLedgers(): Promise<BondLedgerInventory> {
  const response = await fetch(LEDGER_ENDPOINT, { cache: "no-store" });
  const payload = await jsonPayload(response);
  if (!response.ok) {
    throw new Error(
      errorFromPayload(payload, `台账清单读取失败（HTTP ${response.status}）`),
    );
  }
  const inventory = isRecord(payload) ? payload : {};
  const files = Array.isArray(inventory.files)
    ? inventory.files.filter(isRemoteBondLedgerFile).sort(compareRemoteFiles)
    : [];
  const databaseDates = Array.isArray(inventory.databaseDates)
    ? [
        ...new Set(
          inventory.databaseDates.filter(
            (value): value is string =>
              typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
          ),
        ),
      ].sort()
    : files.map((file) => file.date);
  return {
    files,
    databaseDates,
    availableStartDate:
      typeof inventory.availableStartDate === "string"
        ? inventory.availableStartDate
        : databaseDates.at(0) ?? null,
    availableEndDate:
      typeof inventory.availableEndDate === "string"
        ? inventory.availableEndDate
        : databaseDates.at(-1) ?? null,
  };
}

export async function downloadRemoteBondLedger(
  remote: RemoteBondLedgerFile,
): Promise<void> {
  const response = await fetch(
    `${LEDGER_ENDPOINT}?date=${encodeURIComponent(remote.date)}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    const payload = await jsonPayload(response);
    throw new Error(errorFromPayload(payload, `${remote.date} 台账下载失败`));
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = remote.fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function deleteRemoteBondLedger(date: string): Promise<void> {
  const response = await fetch(
    `${LEDGER_ENDPOINT}?date=${encodeURIComponent(date)}`,
    { method: "DELETE" },
  );
  const payload = await jsonPayload(response);
  if (!response.ok) {
    throw new Error(errorFromPayload(payload, `${date} 台账删除失败`));
  }
}

function isImportResult(value: unknown): value is BondLedgerImportResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.reportDate === "string" &&
    typeof value.statisticsCount === "number" &&
    typeof value.positionCount === "number" &&
    typeof value.transactionCount === "number"
  );
}

function isBondLedgerReport(value: unknown): value is BondLedgerReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.hasData === "boolean" &&
    Array.isArray(value.performanceTrend) &&
    Array.isArray(value.operatingTrend) &&
    isRecord(value.accountPerformanceTrends) &&
    Array.isArray(value.accountPerformanceTrends.trading) &&
    Array.isArray(value.accountPerformanceTrends.available) &&
    Array.isArray(value.holdingTypes) &&
    Array.isArray(value.maturityBuckets) &&
    Array.isArray(value.tradingHoldingTypes) &&
    Array.isArray(value.tradingMaturityBuckets) &&
    Array.isArray(value.topTradingPositions) &&
    Array.isArray(value.transactions) &&
    isRecord(value.transactionTotals) &&
    isRecord(value.returnRiskMetrics) &&
    isRecord(value.metricDeltas) &&
    typeof value.detailMarketValue === "number" &&
    isRecord(value.availability) &&
    ["pledgedQuantity", "availableQuantity", "pledgedMarketValue", "availableMarketValue", "pledgedFaceAmount", "availableFaceAmount"].every((key) => {
      const amount = (value.availability as Record<string, unknown>)[key];
      return amount === null || (typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
    }) &&
    Array.isArray(value.auditChecks) &&
    typeof value.auditPassed === "boolean"
  );
}

function isRemoteBondLedgerFile(value: unknown): value is RemoteBondLedgerFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.date === "string" &&
    typeof value.fileName === "string" &&
    typeof value.key === "string" &&
    typeof value.size === "number" &&
    typeof value.etag === "string" &&
    typeof value.uploadedAt === "string"
  );
}

function compareRemoteFiles(
  left: RemoteBondLedgerFile,
  right: RemoteBondLedgerFile,
): number {
  return left.date.localeCompare(right.date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorFromPayload(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : fallback;
}

async function jsonPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}
