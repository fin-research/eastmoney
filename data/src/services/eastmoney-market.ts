import { ApiError } from "../http";
import { fetchChoiceTable } from "../choice/client";
import { A_SHARE_INDICES, SW_LEVEL_ONE_INDUSTRIES } from "./industry";
import { loadTradingDay } from "../trading-calendar";

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Daily market snapshot for the report: Choice CSS prices and a dedicated exchange calendar. */
export async function collectMarketSnapshot(env: Pick<Cloudflare.Env, "CHOICE_RPC" | "CHOICE_RPC_TOKEN" | "CHOICE_FAST_LIMIT" | "CHOICE_OTHER_LIMIT">, reportDate: string) {
  const calendar = await loadTradingDay(env, reportDate);
  if (!calendar.isTradingDay) throw new ApiError(503, "非交易日无当日行情", { code: "MARKET_CLOSED" });

  const allCodes = [...SW_LEVEL_ONE_INDUSTRIES, ...A_SHARE_INDICES].map(([code]) => code);
  const current = await fetchChoiceTable(env, "css", {
    codes: allCodes.join(","), indicators: "CLOSE,PRECLOSE,MV",
    options: `TradeDate=${reportDate},EndDate=${reportDate}`,
  });
  const currentRows = new Map(current.rows.map(row => [String(row.code).toUpperCase(), row]));
  const equities = A_SHARE_INDICES.map(([code, name]) => {
    const row = currentRows.get(code);
    const close = numeric(row?.CLOSE), previous = numeric(row?.PRECLOSE);
    return { name, close, change_pct: close !== null && previous !== null && previous > 0 ? (close / previous - 1) * 100 : null };
  });
  const industries = SW_LEVEL_ONE_INDUSTRIES.map(([code, name]) => {
    const row = currentRows.get(code);
    const close = numeric(row?.CLOSE), previous = numeric(row?.PRECLOSE);
    return { name, change_pct: close !== null && previous !== null && previous > 0 ? (close / previous - 1) * 100 : null,
      market_cap_yuan: numeric(row?.MV) };
  });
  if (equities.some(row => row.close === null || row.change_pct === null) ||
      industries.some(row => row.change_pct === null || row.market_cap_yuan === null)) {
    throw new ApiError(503, "Choice CSS 当日指数或行业行情不完整", { code: "RESOURCE_NOT_AVAILABLE" });
  }

  const [turnover, previousTurnover] = await Promise.all([
    fetchChoiceTable(env, "css", {
      codes: "800004.EI", indicators: "AMOUNT", options: `TradeDate=${reportDate},EndDate=${reportDate}`,
    }),
    fetchChoiceTable(env, "css", {
      codes: "800004.EI", indicators: "AMOUNT",
      options: `TradeDate=${calendar.previousTradingDate},EndDate=${calendar.previousTradingDate}`,
    }),
  ]);
  const amount = numeric(turnover.rows[0]?.AMOUNT), previousAmount = numeric(previousTurnover.rows[0]?.AMOUNT);
  if (amount === null || previousAmount === null) {
    throw new ApiError(503, "Choice CSS 成交额不完整", { code: "RESOURCE_NOT_AVAILABLE" });
  }
  return { dataDate: reportDate, equities, industries,
    turnoverYi: amount / 1e8,
    turnoverChangeYi: (amount - previousAmount) / 1e8,
    tradingDates: [calendar.previousTradingDate, reportDate] };
}
