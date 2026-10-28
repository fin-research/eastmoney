import type { WorkflowStep } from "cloudflare:workers";
import { scheduledTradingDay } from "../src/lib/server/scheduled-trading-day.ts";
import { currentReportDate } from "../src/report-date.ts";
import { generateMarketBriefingFromNews } from "../src/lib/server/market-briefing.ts";
import {
  collectFocusNews, collectOpenMarket, collectFixedIncome, collectEquity,
  collectPrimary, collectSecondary, collectInventory,
} from "../src/lib/server/market-report-modules.ts";
import { saveMarketReport } from "../src/lib/server/market-report.ts";

import type { MarketBriefingParams } from "../src/lib/market-briefing-types.ts";
export type { MarketBriefingParams } from "../src/lib/market-briefing-types.ts";
export const MARKET_BRIEFING_CRON = "0 9 * * MON-FRI";

export async function startMarketBriefing(env: Env, scheduledTime: number) {
  const reportDate = currentReportDate(new Date(scheduledTime));
  if (!await scheduledTradingDay(env, reportDate)) return;
  const id = `market-briefing-${reportDate}`;
  // create is atomic by ID; get only confirms a duplicate after an uncertain create.
  try { return await env.MARKET_BRIEFING.create({ id, params: { reportDate } }); }
  catch (error) {
    try {
      const instance = await env.MARKET_BRIEFING.get(id);
      await instance.status();
      return instance;
    } catch { throw error; }
  }
}

const DATA_STEP_OPTIONS = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "3 minutes",
} as const;

/** Every durable step and its dependencies are visible here. */
export async function runMarketBriefing(
  env: Env,
  step: WorkflowStep,
  params: MarketBriefingParams,
  dependencies = { generateMarketBriefingFromNews, saveMarketReport },
) {
  const { reportDate } = params;

  try {
    const modules = await Promise.allSettled([
      step.do("collect-focus-news", { ...DATA_STEP_OPTIONS, timeout: "10 minutes" }, () => collectFocusNews(env, reportDate)),
      step.do("collect-open-market", DATA_STEP_OPTIONS, () => collectOpenMarket(env, reportDate)),
      step.do("collect-fixed-income", DATA_STEP_OPTIONS, () => collectFixedIncome(env, reportDate)),
      step.do("collect-equity", DATA_STEP_OPTIONS, () => collectEquity(env, reportDate)),
      step.do("collect-primary", DATA_STEP_OPTIONS, () => collectPrimary(env, reportDate)),
      step.do("collect-secondary", DATA_STEP_OPTIONS, () => collectSecondary(env, reportDate)),
      step.do("collect-inventory", DATA_STEP_OPTIONS, () => collectInventory(env, reportDate)),
    ]);
    const news = stepValue(modules[0]);
    const report = {
      report_date: reportDate,
      generated_at: new Date().toISOString(),
      ...stepValue(modules[1]),
      ...stepValue(modules[2]),
      ...stepValue(modules[3]),
      ...stepValue(modules[4]),
      ...stepValue(modules[5]),
      ...stepValue(modules[6]),
    };
    const focus = await step.do("generate-focus", {
      retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes",
    }, () => dependencies.generateMarketBriefingFromNews(env, reportDate, news, { retry: false, report }));

    const saved = await step.do("archive-report", DATA_STEP_OPTIONS, async () => {
      const snapshot = await dependencies.saveMarketReport(env.EASTMONEY, reportDate,
        report, `1、${focus.stock}\n2、${focus.bond}`);
      return { finalizedAt: snapshot.finalized_at, focus: snapshot.focus_text };
    });
    return { reportDate, status: "complete", finalizedAt: saved.finalizedAt, focus: saved.focus };
  } catch (error) {
    // Errors thrown outside a durable step become generic runtime errors in instance.status().
    // Keep the final business failure in a step so the event consumer receives its real details.
    return await step.do("workflow-failure", { retries: { limit: 0, delay: "1 second" } }, async () => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
}

function stepValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
