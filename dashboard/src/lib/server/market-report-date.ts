import { currentReportDate, isBeforeReportCutoff } from "../../report-date.ts";
import { tradingDaySchema } from "../../data-contracts.ts";
import { knownMarketClosure } from "./market-calendar.ts";

/** Local fallback when the dedicated exchange calendar is unavailable. */
export function defaultReportDate(now = new Date()): string {
  const cursor = new Date(`${currentReportDate(now)}T00:00:00Z`);
  if (isBeforeReportCutoff(now)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (knownMarketClosure(cursor.toISOString().slice(0, 10)) === true) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
}

/** The read path asks the same standalone calendar as report collection, then falls back locally. */
export async function resolveDefaultReportDate(env: Pick<Env, "DATA"> | undefined, now = new Date()): Promise<string> {
  const cursor = new Date(`${currentReportDate(now)}T00:00:00Z`);
  if (isBeforeReportCutoff(now)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  const candidate = cursor.toISOString().slice(0, 10);
  if (env?.DATA) {
    try {
      const response = await env.DATA.fetch(new Request(
        `https://eastmoney.hasbai.xyz/data/trading-days?date=${candidate}&fields=date,isTradingDay,previousTradingDate`,
        { signal: AbortSignal.timeout(8_000) },
      ));
      if (response.ok) {
        const calendar = tradingDaySchema.safeParse(await response.json());
        if (calendar.success && calendar.data.date === candidate) {
          return calendar.data.isTradingDay ? candidate : calendar.data.previousTradingDate;
        }
      }
    } catch { /* A finalized R2 report remains readable during a calendar outage. */ }
  }
  return defaultReportDate(now);
}
