import { tradingDaySchema } from "../../data-contracts.ts";
import { knownMarketClosure } from "../../market-calendar.ts";
import { messengerRequest } from "./messenger.ts";

/**
 * Scheduled dispatch uses the Choice calendar. When it is unavailable, the local closure table
 * decides for the years it covers and Telegram is alerted; an unverified year still fails.
 */
export async function scheduledTradingDay(env: Pick<Env, "DATA"> & Partial<Pick<Env, "MESSENGER">>, date: string, alertTimeoutMs = 5_000): Promise<boolean> {
  if ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return false;
  try {
    const calendar = await fetchCalendar(env, date);
    if (!calendar.isTradingDay) console.log(JSON.stringify({ event: "market_briefing_cron_skipped", date, reason: "market_closed" }));
    return calendar.isTradingDay;
  } catch (error) {
    const closed = knownMarketClosure(date);
    const reason = (error instanceof Error ? error.message : "unknown").slice(0, 200);
    console.error(JSON.stringify({ event: "market_briefing_calendar_unavailable", date, fallback: closed === null ? "none" : closed ? "closed" : "open", reason }));
    await alertCalendarUnavailable(env, date, closed, alertTimeoutMs);
    if (closed === null) throw error;
    return !closed;
  }
}

async function fetchCalendar(env: Pick<Env, "DATA">, date: string) {
  const response = await env.DATA.fetch(new Request(
    `https://eastmoney.hasbai.xyz/data/trading-days?date=${date}&fields=date,isTradingDay,previousTradingDate`,
    { signal: AbortSignal.timeout(10_000) },
  ));
  if (!response.ok) throw new Error(`Trading calendar HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Trading calendar response missing");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new Error("Trading calendar response too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const calendar = tradingDaySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (calendar.date !== date || !validDate(calendar.previousTradingDate) || calendar.previousTradingDate >= date) throw new Error("Trading calendar date mismatch");
  return calendar;
}

/** Best effort: an alert failure must never block or change the scheduled decision. */
async function alertCalendarUnavailable(env: Partial<Pick<Env, "MESSENGER">>, date: string, closed: boolean | null, timeoutMs: number) {
  if (!env.MESSENGER) return;
  const action = closed === null ? "本地休市表没有该年度数据，未启动工作流，请人工触发。"
    : closed ? "本地休市表显示休市，未启动工作流。"
      : "按本地休市表判定为交易日，将启动工作流。日历持续不可用时它会失败并另有失败通知，恢复后重启该实例。";
  try {
    const response = await messengerRequest(env.MESSENGER, "/messages", {
      source: "market-briefing", idempotencyKey: `calendar-unavailable/${date}`, channel: "telegram",
      text: `【市场点评】交易日历不可用\n日期：${date}\n${action}`,
    }, AbortSignal.timeout(timeoutMs));
    if (!response.ok) console.error(JSON.stringify({ event: "market_briefing_calendar_alert_failed", date, status: response.status }));
  } catch { console.error(JSON.stringify({ event: "market_briefing_calendar_alert_failed", date })); }
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
