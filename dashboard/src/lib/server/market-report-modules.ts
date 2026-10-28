import type { z } from "zod";
import {
  bondInfosSchema, cfetsRatesSchema, favoriteQuotesSchema, futuresQuotesSchema,
  governmentBondsSchema, industrySnapshotSchema, marginBalancesSchema, omoOperationsSchema,
  primaryIssuesSchema, stockSummarySchema, todayTradesSchema, tradingDaySchema,
} from "../../data-contracts.ts";
import {
  buildOpenMarketModule, buildFixedIncomeModule, buildEquityModule, buildPrimaryModule,
  buildSecondaryModule, buildInventoryModule, dayOffset, referencedBondCodes,
} from "../../market-report-resources.ts";
import { reportDataSchema } from "../../market-report.ts";
import { currentReportDate } from "../../report-date.ts";
import { completeAll, fetchBriefingNewsDetails, fetchDataJson, prepareBriefingNews } from "./market-briefing.ts";

const todayTradesPath = "today-trades?limit=300&fields=bondUniCode,remainingTenor,cbYte,tradeYield,tradeYieldSubCb";
const favoriteQuotesPath = "favorite-quotes?limit=100&fields=bondUniCode,bondShortName,remainingTenor,remainingTenorDay,cbYield,bidYield,bidEntryPrice,ofrYield,ofrEntryPrice,tradeEntryPrice,tradeYieldSubCb";

// Each function owns fetching, normalization and validation for one report module.
// None creates Workflow steps or retries requests.
export async function collectFocusNews(env: Env, reportDate: string) {
  assertCurrentDate(reportDate);
  const items = await fetchBriefingNewsDetails(env, reportDate);
  return checkpoint(reportDate, prepareBriefingNews(items));
}

export async function collectOpenMarket(env: Env, reportDate: string) {
  const operations = await fetchModuleData(env, reportDate,
    `omo?startDate=${dayOffset(reportDate, -35)}&endDate=${reportDate}&fields=operationDate,operationName,duration,interestRate,operationAmount`, omoOperationsSchema);
  return checkpoint(reportDate, reportDataSchema.pick({ omo_operations: true }).parse(buildOpenMarketModule(operations)));
}

export async function collectFixedIncome(env: Env, reportDate: string) {
  const [dr, dibo, governmentBonds, futures] = await completeAll([
    fetchModuleData(env, reportDate, `cfets?date=${reportDate}&source=DR&fields=bondCode,weightedYield,weightedYieldUpDownValueBp`, cfetsRatesSchema),
    fetchModuleData(env, reportDate, `cfets?date=${reportDate}&source=DIBO&fields=bondCode,weightedYield,weightedYieldUpDownValueBp`, cfetsRatesSchema),
    fetchModuleData(env, reportDate, `bond-top-case?date=${reportDate}&fields=ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp`, governmentBondsSchema),
    fetchModuleData(env, reportDate, "futures-latest?fields=contractCode,lastPrice,upDownValuePct", futuresQuotesSchema),
  ]);
  return checkpoint(reportDate, reportDataSchema.pick({ funding_rates: true, government_bonds: true, futures: true })
    .parse(buildFixedIncomeModule({ dr, dibo, governmentBonds, futures })));
}

export async function collectEquity(env: Env, reportDate: string) {
  const [industry, stock, margin, calendar] = await completeAll([
    fetchModuleData(env, reportDate,
      `industry?date=${reportDate}&fields=dataDate,equities,industries,turnoverYi,turnoverChangeYi`, industrySnapshotSchema),
    fetchModuleData(env, reportDate, `stock-summary?date=${reportDate}&fields=title,time,paragraphs`, stockSummarySchema),
    fetchModuleData(env, reportDate, `margin?date=${reportDate}&fields=DIM_DATE,TOTAL_RZRQYE,TOTAL_RZYE,TOTAL_RQYE`, marginBalancesSchema),
    fetchModuleData(env, reportDate, `trading-days?date=${reportDate}&fields=date,isTradingDay,previousTradingDate`, tradingDaySchema),
  ]);
  assertTradingDate(calendar, reportDate);
  if (industry.dataDate !== reportDate) throw new Error("当日股票行情尚未更新，请重试");
  return checkpoint(reportDate, reportDataSchema.pick({
    stock_paragraphs: true, margin: true, equities: true, equity_data_time: true,
    turnover_yi: true, turnover_change_yi: true, industries: true, industry_data_date: true,
  }).parse(buildEquityModule({ industry, stock, margin })));
}

export async function collectPrimary(env: Env, reportDate: string) {
  const calendar = await fetchModuleData(env, reportDate,
    `trading-days?date=${reportDate}&fields=date,isTradingDay,previousTradingDate`, tradingDaySchema);
  assertTradingDate(calendar, reportDate);
  const previousDate = calendar.previousTradingDate;
  const query = new URLSearchParams({
    date: reportDate, startDate: previousDate,
    fields: ["bidStartDate", "issueStartDate", "biddingTime", "comShortName", "issuerShortName", "issuerShortNameCn",
      "comFullName", "issuerName", "publicOffering", "publicOfferingText", "offeringType", "issueWay", "raisingMode",
      "bondTypeText", "bondShortName", "issueTenor", "planIssueAmount", "issueCouponRate"].join(","),
  });
  const issues = await fetchModuleData(env, reportDate, `primary-issues?${query}`, primaryIssuesSchema);
  return checkpoint(reportDate, reportDataSchema.pick({ primary_summary: true, primary_issues: true })
    .parse(buildPrimaryModule(issues, reportDate, previousDate)));
}

export async function collectSecondary(env: Env, reportDate: string) {
  const trades = await fetchModuleData(env, reportDate, todayTradesPath, todayTradesSchema);
  const infos = await fetchBondInfos(env, reportDate, referencedBondCodes(trades, []));
  return checkpoint(reportDate, reportDataSchema.pick({ secondary_bonds: true }).parse(buildSecondaryModule(trades, infos)));
}

export async function collectInventory(env: Env, reportDate: string) {
  const [quotes, trades] = await completeAll([
    fetchModuleData(env, reportDate, favoriteQuotesPath, favoriteQuotesSchema),
    fetchModuleData(env, reportDate, todayTradesPath, todayTradesSchema),
  ]);
  const infos = await fetchBondInfos(env, reportDate, referencedBondCodes([], quotes));
  return checkpoint(reportDate, reportDataSchema.pick({ inventory_bonds: true }).parse(buildInventoryModule(quotes, trades, infos)));
}

function fetchBondInfos(env: Env, reportDate: string, codes: string[]) {
  if (!codes.length) return Promise.resolve([]);
  const query = new URLSearchParams({ codes: codes.join(","), fields: "bondUniCode,bondShortName,comShortName,bondType,bondOfferingType,sciTechInnoBondStatus" });
  return fetchModuleData(env, reportDate, `bond-infos?${query}`, bondInfosSchema);
}

function assertTradingDate(calendar: { date: string; isTradingDay: boolean }, reportDate: string) {
  if (calendar.date !== reportDate || !calendar.isTradingDay) throw new Error("交易日历未确认当日为交易日，请重试");
}

function assertCurrentDate(reportDate: string) {
  if (currentReportDate() !== reportDate) throw new Error("采集已跨日，不能混入其他日期的实时行情");
}

async function fetchModuleData<T>(env: Env, reportDate: string, path: string, schema: z.ZodType<T>): Promise<T> {
  assertCurrentDate(reportDate);
  return fetchDataJson(env, `https://data.internal/data/${path}`, schema);
}

function checkpoint<T>(reportDate: string, data: T): T {
  assertCurrentDate(reportDate);
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 900 * 1024) throw new Error("模块数据超过步骤大小限制");
  return data;
}
