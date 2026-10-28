const ISO_REPORT_SUFFIX = /(\d{4})-(\d{2})-(\d{2})\.html$/i;
const COMPACT_REPORT_SUFFIX = /(\d{4})(\d{2})(\d{2})\.html$/i;

export const MAX_FUND_REPORT_BYTES = 20 * 1024 * 1024;

export interface FundReportListItem {
  date: string;
  url: string;
  size: number;
  uploadedAt: string;
}

export function fundReportDateFromFileName(fileName: string): string | null {
  const normalizedName = fileName.trim();
  const match =
    ISO_REPORT_SUFFIX.exec(normalizedName) ??
    COMPACT_REPORT_SUFFIX.exec(normalizedName);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  return isFundReportDate(date) ? date : null;
}

export function fundReportFileName(date: string): string {
  if (!isFundReportDate(date)) {
    throw new TypeError("资金日报日期必须是有效的 YYYY-MM-DD");
  }
  return `${date}.html`;
}

export function fundReportObjectKey(date: string): string {
  return `fund-reports/${fundReportFileName(date)}`;
}

export function isFundReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}
