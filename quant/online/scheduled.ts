/** Calendar confirmation precedes Workflow creation; business steps remain unchanged. */
export async function startScheduledInference(env: Pick<Env, "DATA" | "INFERENCE">, scheduledTime: number) {
  const local = new Date(scheduledTime + 8 * 3600_000);
  const date = local.toISOString().slice(0, 10);
  if ([0, 6].includes(local.getUTCDay())) return;
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
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error("Trading calendar response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const calendar: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!calendar || typeof calendar !== "object" || !("date" in calendar) || calendar.date !== date
      || !("isTradingDay" in calendar) || typeof calendar.isTradingDay !== "boolean"
      || !("previousTradingDate" in calendar) || !validDate(calendar.previousTradingDate)
      || calendar.previousTradingDate >= date) throw new Error("Invalid trading calendar response");
    if (!calendar.isTradingDay) {
      console.log(JSON.stringify({ event: "quant_cron_skipped", date, reason: "market_closed" }));
      return;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "quant_calendar_unavailable", date }));
    throw error;
  }
  const id = `bond-${date}`;
  try { return await env.INFERENCE.create({ id, params: { as_of_date: date } }); }
  catch (error) {
    try { const instance = await env.INFERENCE.get(id); await instance.status(); return instance; }
    catch { throw error; }
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
