import { parseQuantFundReport } from './quant-fund-report.ts';
import { persistQuantInputs } from './quant-input-repository.ts';
import type { withPostgres } from './postgres.ts';
import { MAX_FUND_REPORT_BYTES } from './fund-report-contract.ts';

type Database = <T>(operation: Parameters<typeof withPostgres<T>>[2]) => Promise<T>;

export async function runFundReportSync(
  bucket: R2Bucket, db: Database, date: string,
) {
  const key = `fund-reports/${date}.html`;
  const body = await bucket.get(key);
  if (!body) return { stored: 0, failures: [], missing: [{ source: key, dates: [date], reason: 'report_not_uploaded' }] };
  if (body.size > MAX_FUND_REPORT_BYTES) throw new Error('Fund report exceeds size limit');
  const report = { rows: parseQuantFundReport(await body.text(), date) };
  const stored = await db(async (client) => {
    const count = await persistQuantInputs(client, report.rows);
    return count;
  });
  return { stored, failures: [] };
}

/** Re-read the bounded completed trading-day window, including late uploads and corrections. */
export async function runFundReportWindowSync(bucket: R2Bucket, db: Database, dates: string[]) {
  if (dates.length > 14 || dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error('Invalid fund report window');
  }
  let stored = 0;
  const failures: Array<{ source: string; error: string; kind: 'execution' }> = [];
  const missing: Array<{ source: string; dates: string[]; reason: string }> = [];
  for (const date of [...new Set(dates)].sort()) {
    try {
      const result = await runFundReportSync(bucket, db, date);
      stored += result.stored;
      missing.push(...(result.missing ?? []));
    } catch (error) {
      failures.push({ source: `fund-reports/${date}.html`, error: error instanceof Error ? error.message : 'Fund report failed', kind: 'execution' });
    }
  }
  return { stored, failures, missing };
}
