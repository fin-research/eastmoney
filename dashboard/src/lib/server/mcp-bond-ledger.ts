import { z } from 'zod';
import { dateSchema } from '../commentary.ts';
import type { BondLedgerReport, LedgerAuditCheck } from '../bond-ledger/types.ts';

// Non-finite reconciliation values become null in the business API JSON wire format.
type AuditCheckWire = { [Key in keyof LedgerAuditCheck]: LedgerAuditCheck[Key] extends number ? number | null : LedgerAuditCheck[Key] };
type ReportWire = Omit<BondLedgerReport, 'auditChecks'> & { auditChecks: AuditCheckWire[] };

const number = z.number();
const nullableNumber = number.nullable();
const performance = z.object({
  date: dateSchema, principal: number, timeWeightedPrincipal: number, marketValue: number,
  leverage: number, modifiedDuration: number, dailyRevenue: number, cumulativeProfit: number,
  ytdAnnualizedReturn: nullableNumber, ytdExTaxAnnualizedReturn: nullableNumber,
});
const trend = z.object({ date: dateSchema, principal: number, marketValue: number, dailyRevenue: number });
const holdingType = z.object({
  category: z.string(), marketValue: number, share: number, weightedYield: nullableNumber,
  weightedRemainingYears: nullableNumber, dv01: number, dailyProfit: number, ytdProfit: number, positionCount: number,
});
const maturityBucket = z.object({
  bucket: z.string(), marketValue: number, share: number, weightedYield: nullableNumber, positionCount: number,
});
// Every object strips unknown fields, including future storage/audit or personnel metadata.
export const bondLedgerReportSchema = z.object({
  hasData: z.boolean(), currentPerformance: performance.nullable(), performanceTrend: z.array(performance),
  operatingTrend: z.array(performance.extend({
    tradingMarketValue: number, availableMarketValue: number, flatStatic: nullableNumber, dv01: number,
    cumulativeTaxExemptProfit: nullableNumber, cumulativeExTaxProfit: nullableNumber,
    fullPoolYtdAnnualizedReturn: nullableNumber, fullPoolYtdExTaxAnnualizedReturn: nullableNumber,
  })),
  accountPerformanceTrends: z.object({ trading: z.array(trend), available: z.array(trend) }),
  holdingTypes: z.array(holdingType), maturityBuckets: z.array(maturityBucket),
  tradingHoldingTypes: z.array(holdingType), tradingMaturityBuckets: z.array(maturityBucket),
  topTradingPositions: z.array(z.object({ name: z.string(), category: z.string(), remainingYears: nullableNumber, marketValue: number, reportYield: nullableNumber })),
  transactions: z.array(z.object({ date: dateSchema, side: z.enum(['买入', '卖出', '到期']), code: z.string(), name: z.string(), category: z.string(), quantity: number, faceAmount: number, realizedProfit: nullableNumber })),
  transactionTotals: z.object({ 买入: number, 卖出: number, 到期: number }),
  rangeProfit: nullableNumber, rangeAnnualizedReturn: nullableNumber, ytdAnnualizedReturn: nullableNumber,
  returnRiskMetrics: z.object({ annualizedVolatility: nullableNumber, maxDrawdown: nullableNumber, validDayCount: number, maxDrawdownPeakDate: dateSchema.nullable(), maxDrawdownTroughDate: dateSchema.nullable() }),
  transactionCount: number,
  metricDeltas: z.object({ marketValue: nullableNumber, leverage: nullableNumber, modifiedDuration: nullableNumber, ytdAnnualizedReturn: nullableNumber, reportedYtdAnnualizedReturn: nullableNumber, reportedYtdExTaxAnnualizedReturn: nullableNumber, annualizedVolatility: nullableNumber, rangeProfit: nullableNumber, transactionCount: nullableNumber }),
  detailMarketValue: number,
  availability: z.object({ pledgedQuantity: nullableNumber, availableQuantity: nullableNumber, pledgedMarketValue: nullableNumber, availableMarketValue: nullableNumber, pledgedFaceAmount: nullableNumber, availableFaceAmount: nullableNumber }),
  auditChecks: z.array(z.object({ key: z.enum(['scale', 'leverage', 'profit']), label: z.string(), pass: z.boolean(), actual: nullableNumber, expected: nullableNumber, difference: nullableNumber, tolerance: nullableNumber })),
  auditPassed: z.boolean(), effectiveStartDate: dateSchema.nullable(), effectiveEndDate: dateSchema.nullable(),
}) satisfies z.ZodType<ReportWire>;
const inventory = z.object({ databaseDates: z.array(dateSchema), availableStartDate: dateSchema.nullable(), availableEndDate: dateSchema.nullable() });

export function projectBondLedgerResult(input: Record<string, unknown>, value: unknown): unknown {
  const query = input.query as { start?: string } | undefined;
  return query?.start ? bondLedgerReportSchema.parse(value) : inventory.parse(value);
}
