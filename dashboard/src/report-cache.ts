// Legacy browser-cache utility. The production market-briefing page no longer
// imports this module: current-day data is live, historical dates use finalized R2 snapshots.
import type { ReportData } from "./types";

const REPORT_CACHE_PREFIX = "dm-market-report:data:v1:";
const MAX_CACHED_REPORTS = 2;

export interface ReportCacheStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

type ReportFetcher = (
  reportDate: string,
  refresh: boolean,
) => Promise<ReportData>;

export function readCachedReport(
  storage: ReportCacheStorage,
  reportDate: string,
): ReportData | null {
  const key = cacheKey(reportDate);
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (isReportData(parsed, reportDate)) return parsed;
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage may be unavailable; the caller will fall back to the API.
    }
  }
  return null;
}

export function writeCachedReport(
  storage: ReportCacheStorage,
  report: ReportData,
): void {
  try {
    const key = cacheKey(report.report_date);
    makeRoomForReport(storage, key);
    storage.setItem(key, JSON.stringify(report));
  } catch {
    // Quota and privacy-mode failures must not block a successful report load.
  }
}

export async function resolveReportData(
  storage: ReportCacheStorage | null,
  reportDate: string,
  currentDate: string,
  refresh: boolean,
  fetcher: ReportFetcher,
): Promise<ReportData> {
  const isCurrentDate = reportDate === currentDate;
  const cachedReport = refresh || !storage
    ? null
    : readCachedReport(storage, reportDate);

  if (
    cachedReport &&
    (!isCurrentDate || reportHasDataForDate(cachedReport, reportDate))
  ) {
    return cachedReport;
  }

  let refreshed = refresh || (isCurrentDate && cachedReport !== null);
  let report = await fetcher(reportDate, refreshed);

  if (
    isCurrentDate &&
    !refreshed &&
    !reportHasDataForDate(report, reportDate)
  ) {
    refreshed = true;
    report = await fetcher(reportDate, true);
  }

  if (storage) writeCachedReport(storage, report);
  return report;
}

export function reportHasDataForDate(
  report: ReportData,
  reportDate: string,
): boolean {
  return (
    report.report_date === reportDate && report.industry_data_date === reportDate
  );
}

function makeRoomForReport(
  storage: ReportCacheStorage,
  nextKey: string,
): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(REPORT_CACHE_PREFIX) && key !== nextKey) keys.push(key);
  }
  keys.sort((left, right) => right.localeCompare(left));
  for (const key of keys.slice(MAX_CACHED_REPORTS - 1)) {
    storage.removeItem(key);
  }
}

function cacheKey(reportDate: string): string {
  return `${REPORT_CACHE_PREFIX}${reportDate}`;
}

function isReportData(value: unknown, reportDate: string): value is ReportData {
  if (!isRecord(value) || value.report_date !== reportDate) return false;
  const rates = value.rates;
  const primarySummary = value.primary_summary;
  return (
    typeof value.generated_at === "string" &&
    Array.isArray(value.omo) &&
    isRecord(rates) &&
    Array.isArray(rates.dr) &&
    Array.isArray(rates.dibo) &&
    Array.isArray(rates.bonds) &&
    Array.isArray(rates.futures) &&
    Array.isArray(value.stock_paragraphs) &&
    Array.isArray(value.margin) &&
    Array.isArray(value.equities) &&
    (typeof value.equity_data_time === "string" ||
      value.equity_data_time === null) &&
    isNullableNumber(value.turnover_yi) &&
    isNullableNumber(value.turnover_change_yi) &&
    Array.isArray(value.industries) &&
    typeof value.industry_data_date === "string" &&
    isRecord(primarySummary) &&
    typeof primarySummary.current_amount === "number" &&
    isNullableNumber(primarySummary.change_amount) &&
    Array.isArray(value.primary) &&
    Array.isArray(value.secondary) &&
    Array.isArray(value.inventory)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
