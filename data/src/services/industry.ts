import { fetchChoiceTable, type ChoiceTable } from "../choice/client";
import { ApiError } from "../http";

export const SW_LEVEL_ONE_INDUSTRIES = [
  ["801010.SWI", "农林牧渔"],
  ["801030.SWI", "基础化工"],
  ["801040.SWI", "钢铁"],
  ["801050.SWI", "有色金属"],
  ["801080.SWI", "电子"],
  ["801110.SWI", "家用电器"],
  ["801120.SWI", "食品饮料"],
  ["801130.SWI", "纺织服饰"],
  ["801140.SWI", "轻工制造"],
  ["801150.SWI", "医药生物"],
  ["801160.SWI", "公用事业"],
  ["801170.SWI", "交通运输"],
  ["801180.SWI", "房地产"],
  ["801200.SWI", "商贸零售"],
  ["801210.SWI", "社会服务"],
  ["801230.SWI", "综合"],
  ["801710.SWI", "建筑材料"],
  ["801720.SWI", "建筑装饰"],
  ["801730.SWI", "电力设备"],
  ["801740.SWI", "国防军工"],
  ["801750.SWI", "计算机"],
  ["801760.SWI", "传媒"],
  ["801770.SWI", "通信"],
  ["801780.SWI", "银行"],
  ["801790.SWI", "非银金融"],
  ["801880.SWI", "汽车"],
  ["801890.SWI", "机械设备"],
  ["801950.SWI", "煤炭"],
  ["801960.SWI", "石油石化"],
  ["801970.SWI", "环保"],
  ["801980.SWI", "美容护理"],
] as const;

export const A_SHARE_INDICES = [
  ["000001.SH", "上证指数"],
  ["399001.SZ", "深证成指"],
  ["399006.SZ", "创业板指"],
  ["000688.SH", "科创50"],
] as const;

export interface IndustryPoint {
  name: string;
  change_pct: number | null;
  market_cap_yuan: number | null;
}

export interface EquityPoint {
  name: string;
  close: number | null;
  change_pct: number | null;
}

export interface ChoiceMarket {
  industries: IndustryPoint[];
  dataDate: string;
  equities: EquityPoint[];
  tradingDates: string[];
  turnoverYi: number | null;
  turnoverChangeYi: number | null;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rowDate(row: Record<string, unknown>): string | null {
  if (typeof row.date !== "string") return null;
  const match = row.date.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function rowsByDate(table: ChoiceTable): Map<string, Map<string, Record<string, unknown>>> {
  const result = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of table.rows) {
    const date = rowDate(row);
    const code = typeof row.code === "string" ? row.code.toUpperCase() : "";
    if (!date || !code) continue;
    const items = result.get(date) ?? new Map<string, Record<string, unknown>>();
    items.set(code, row);
    result.set(date, items);
  }
  return result;
}

export async function collectChoiceMarket(
  env: Pick<Cloudflare.Env, "CHOICE_RPC" | "CHOICE_RPC_TOKEN" | "CHOICE_FAST_LIMIT" | "CHOICE_OTHER_LIMIT">,
  reportDate: string,
): Promise<ChoiceMarket> {
  const startDate = daysBefore(reportDate, 21);
  // The C++ SDK is stateful and serialized by the office service. Keep the
  // original call order instead of creating a burst of queued connections.
  const failures: unknown[] = [];
  async function component(name: string, payload: Record<string, unknown>): Promise<ChoiceTable> {
    try { return await fetchChoiceTable(env, "csd", payload); }
    catch (error) {
      if (error instanceof ApiError && error.status === 429) throw error;
      failures.push(error);
      console.warn(JSON.stringify({ event: "market_component_unavailable", component: name }));
      return { function: "CSD", fields: [], rows: [] };
    }
  }
  const industryTable = await component("industries", {
    codes: SW_LEVEL_ONE_INDUSTRIES.map(([code]) => code).join(","),
    indicators: "PCTCHANGE,MV",
    startDate,
    endDate: reportDate,
    options: "Period=1",
  });
  const turnoverTable = await component("turnover", {
    codes: "800004.EI",
    indicators: "AMOUNT",
    startDate,
    endDate: reportDate,
    options: "Period=1",
  });
  const equityTable = await component("equities", {
    codes: A_SHARE_INDICES.map(([code]) => code).join(","),
    indicators: "CLOSE,PCTCHANGE",
    startDate,
    endDate: reportDate,
    options: "Period=1",
  });

  if (failures.length === 3) throw failures[0];
  const industryRows = rowsByDate(industryTable);
  const equityRows = rowsByDate(equityTable);
  const turnoverRows = rowsByDate(turnoverTable);
  const dates = (rows: Map<string, Map<string, Record<string, unknown>>>) =>
    [...rows.keys()].filter((date) => date <= reportDate).sort();
  const industryDate = dates(industryRows).at(-1);
  const equityDate = dates(equityRows).at(-1);
  const latestIndustry = industryDate ? industryRows.get(industryDate) : undefined;
  const latestEquity = equityDate ? equityRows.get(equityDate) : undefined;
  const industries: IndustryPoint[] = latestIndustry ? SW_LEVEL_ONE_INDUSTRIES.map(([code, name]) => {
    const row = latestIndustry.get(code);
    return { name, change_pct: numeric(row?.PCTCHANGE), market_cap_yuan: numeric(row?.MV) };
  }).sort((left, right) => (right.market_cap_yuan ?? 0) - (left.market_cap_yuan ?? 0)) : [];
  const equities: EquityPoint[] = latestEquity ? A_SHARE_INDICES.map(([code, name]) => {
    const row = latestEquity.get(code);
    return { name, close: numeric(row?.CLOSE), change_pct: numeric(row?.PCTCHANGE) };
  }) : [];
  // A missing quote must not push the whole snapshot back to an older complete day.
  // Calendar evidence may come from any successful market component.
  const tradingDates = [...new Set([
    ...dates(industryRows), ...dates(equityRows), ...dates(turnoverRows),
  ])].sort();
  const dataDate = industryDate ?? equityDate ?? tradingDates.at(-1) ?? reportDate;
  const turnoverSamples = dates(turnoverRows).map((date) =>
    numeric(turnoverRows.get(date)?.get("800004.EI")?.AMOUNT));
  const current = turnoverSamples.at(-1) ?? null;
  const previous = turnoverSamples.at(-2) ?? null;
  const turnoverYi = current === null ? null : current / 1e8;
  const turnoverChangeYi = current === null || previous === null ? null : (current - previous) / 1e8;

  return {
    industries,
    dataDate,
    equities,
    tradingDates,
    turnoverYi,
    turnoverChangeYi,
  };
}
