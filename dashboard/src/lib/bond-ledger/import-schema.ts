import { z } from "zod";
import type { ParsedBondLedger } from "./types";

const amount = z.number().finite();
const optionalAmount = amount.nullable();
const text = z.string().max(500);
const performance = z.object({
  date: z.string().date(), principal: amount, timeWeightedPrincipal: amount,
  marketValue: amount, leverage: amount, modifiedDuration: amount,
  dailyRevenue: amount, cumulativeProfit: amount,
  ytdAnnualizedReturn: optionalAmount, ytdExTaxAnnualizedReturn: optionalAmount,
});
const position = z.object({
  reportDate: z.string().date(), rowNumber: z.number().int().positive(),
  team: text, investmentManager: text, account: text, code: text,
  market: text, name: text, category: text,
  yieldChangeBp: optionalAmount, remainingYears: optionalAmount,
  interestStartDate: z.string().date().nullable(), maturityDate: z.string().date().nullable(),
  currentQuantity: amount.nonnegative(), previousQuantity: amount.nonnegative(), buyQuantity: amount.nonnegative(),
  sellQuantity: amount.nonnegative(), maturityQuantity: amount.nonnegative(),
  pledgedQuantity: amount.nonnegative().nullable().default(null),
  availableQuantity: amount.nonnegative().nullable().default(null),
  couponRate: optionalAmount, valuationYield: optionalAmount, reportYield: optionalAmount,
  fullPrice: optionalAmount, dv01: amount, marketValue: amount, couponIncome: amount,
  taxExemptIncome: amount, realizedProfit: optionalAmount, dailyProfit: amount,
  ytdProfit: amount, fullPriceCost: amount,
}).refine(row => Boolean(row.code.trim() || row.name.trim()), "债券代码和名称不能同时为空").refine(row => {
  const pledged = row.pledgedQuantity ?? null, available = row.availableQuantity ?? null;
  return pledged === null && available === null || pledged !== null && available !== null
    && Math.abs(pledged + available - row.currentQuantity) <= 0.000001;
}, "质押与可用数量必须成对且与持仓守恒");

export const parsedBondLedgerSchema: z.ZodType<ParsedBondLedger> = z.object({
  date: z.string().date(), performance: z.array(performance).min(1).max(10000),
  positions: z.array(position).min(1).max(10000),
}).superRefine((ledger, context) => {
  const dates = new Set<string>(), rows = new Set<number>();
  for (const item of ledger.performance) {
    if (item.date > ledger.date || dates.has(item.date)) {
      context.addIssue({ code: "custom", message: "统计日期越界或重复" });
    }
    dates.add(item.date);
  }
  if (!dates.has(ledger.date)) context.addIssue({ code: "custom", message: "缺少报表日统计" });
  for (const item of ledger.positions) {
    if (item.reportDate !== ledger.date || rows.has(item.rowNumber)) {
      context.addIssue({ code: "custom", message: "持仓日期不一致或行号重复" });
    }
    rows.add(item.rowNumber);
  }
});
