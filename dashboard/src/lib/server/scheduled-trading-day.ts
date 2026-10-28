import { tradingDaySchema } from "../../data-contracts.ts";

/** Scheduled dispatch requires affirmative calendar evidence for its Shanghai date. */
export async function scheduledTradingDay(env: Pick<Env, "DATA">, date: string): Promise<boolean> {
  if ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return false;
  try {
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
    if (!calendar.isTradingDay) console.log(JSON.stringify({ event: "market_briefing_cron_skipped", date, reason: "market_closed" }));
    return calendar.isTradingDay;
  } catch (error) {
    console.error(JSON.stringify({ event: "market_briefing_calendar_unavailable", date }));
    throw error;
  }
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
