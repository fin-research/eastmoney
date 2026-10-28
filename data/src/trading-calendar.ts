import { tradingDaySchema, parseObject, projectObject } from "./contracts";
import { ApiError, jsonResponse, optionalDate, requireMethod, shanghaiToday } from "./http";
import { fetchChoiceTable } from "./choice/client";

export async function loadTradingDay(env: Pick<Cloudflare.Env, "CHOICE_RPC" | "CHOICE_RPC_TOKEN" | "CHOICE_FAST_LIMIT" | "CHOICE_OTHER_LIMIT">, date: string) {
  // Share validated calendar results across internal callers in the same edge location.
  const key = new Request(`https://eastmoney.hasbai.xyz/_cache/trading-days/CNSESH/${date}`);
  let cache: Cache | undefined;
  try {
    if (typeof caches !== "undefined") cache = await caches.open("choice-trading-calendar-v1");
    const response = await cache?.match(key);
    if (response) {
      const parsed = tradingDaySchema.safeParse(await response.json());
      if (parsed.success && parsed.data.date === date && parsed.data.previousTradingDate < date) return parsed.data;
    }
  } catch { console.warn(JSON.stringify({ event: "trading_calendar_cache_read_failed", date })); }
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 35);
  const table = await fetchChoiceTable(env, "tradedates", {
    startDate: start.toISOString().slice(0, 10), endDate: date,
    options: "Market=CNSESH,Period=1,Order=1",
  });
  if (table.function !== "TRADEDATES") throw new ApiError(503, "Choice 交易日返回方法不符", { code: "UPSTREAM_SCHEMA_MISMATCH" });
  if (table.rows.some(row => typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
    || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))
    || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date
    || row.date < start.toISOString().slice(0, 10) || row.date > date)) {
    throw new ApiError(503, "Choice 交易日返回日期无效", { code: "UPSTREAM_SCHEMA_MISMATCH" });
  }
  const dates = [...new Set(table.rows.map(row => row.date).filter((value): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= date))].sort();
  const previousTradingDate = dates.filter(item => item < date).at(-1);
  if (!previousTradingDate) throw new ApiError(503, "Choice 未返回上一交易日", {
    code: "TRADING_CALENDAR_UNAVAILABLE", source: "Choice tradedates", stage: "calendar_lookup",
  });
  const result = parseObject(tradingDaySchema, { date, isTradingDay: dates.includes(date), previousTradingDate }, "Choice 上交所交易日历");
  try {
    await cache?.put(key, Response.json(result, { headers: { "Cache-Control": `max-age=${date < shanghaiToday() ? 86400 : 3600}` } }));
  } catch { console.warn(JSON.stringify({ event: "trading_calendar_cache_write_failed", date })); }
  return result;
}

export async function resolveTradingCalendarData(request: Request, env: Cloudflare.Env, _pathname: string) {
  requireMethod(request, "GET");
  const parameters = new URL(request.url).searchParams;
  const date = optionalDate(parameters, "date") ?? shanghaiToday();
  const result = parseObject(tradingDaySchema, await loadTradingDay(env, date), "Choice 上交所交易日历");
  return projectObject(tradingDaySchema, result, parameters.get("fields"));
}

export async function handleTradingCalendarRoute(request: Request, env: Cloudflare.Env): Promise<Response> {
  return jsonResponse(await resolveTradingCalendarData(request, env, "/trading-days"));
}
