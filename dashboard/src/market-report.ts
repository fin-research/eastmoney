import { z } from "zod";

const nullableNumber = z.number().finite().nullable();
const isoDate = z.string().date();
const isoDateTime = z.string().datetime({ offset: true });

export const reportDataSchema = z
  .object({
    report_date: isoDate,
    generated_at: isoDateTime,
    omo_operations: z.array(
      z
        .object({
          operation_date: isoDate,
          operation_name: z.string(),
          duration: z.string(),
          amount_yi: nullableNumber,
          interest_rate: nullableNumber,
        })
        .strict(),
    ),
    funding_rates: z.array(
      z
        .object({ code: z.string(), rate: nullableNumber, change_bp: nullableNumber })
        .strict(),
    ),
    government_bonds: z.array(
      z
        .object({
          category: z.string(),
          tenor: z.string(),
          code: z.string(),
          yield_rate: nullableNumber,
          change_bp: nullableNumber,
        })
        .strict(),
    ),
    futures: z.array(
      z
        .object({
          code: z.string(),
          last_price: nullableNumber,
          change_pct: nullableNumber,
        })
        .strict(),
    ),
    stock_paragraphs: z.array(z.string()).max(2),
    margin: z
      .object({
        data_date: isoDate.nullable(),
        total: nullableNumber,
        total_change: nullableNumber,
        financing: nullableNumber,
        financing_change: nullableNumber,
        securities_lending: nullableNumber,
        securities_lending_change: nullableNumber,
      })
      .strict(),
    equities: z.array(
      z
        .object({ name: z.string(), close: nullableNumber, change_pct: nullableNumber })
        .strict(),
    ),
    equity_data_time: isoDateTime.nullable(),
    turnover_yi: nullableNumber,
    turnover_change_yi: nullableNumber,
    industries: z.array(
      z
        .object({
          name: z.string(),
          change_pct: nullableNumber,
          market_cap_yuan: nullableNumber,
        })
        .strict(),
    ),
    industry_data_date: isoDate,
    primary_summary: z
      .object({ current_amount: nullableNumber, change_amount: nullableNumber })
      .strict(),
    primary_issues: z.array(
      z
        .object({
          issue_date: z.string(),
          issue_date_key: isoDate,
          issuer: z.string(),
          category: z.string(),
          bond_names: z.array(z.string()),
          tenors: z.array(z.string()),
          coupons: z.array(nullableNumber),
          amount: nullableNumber,
        })
        .strict(),
    ),
    secondary_bonds: z.array(
      z
        .object({
          bond_id: z.string(),
          bond_name: z.string(),
          issuer: z.string(),
          tenor_label: z.string(),
          tenor_years: z.number(),
          valuation: nullableNumber,
          trade_yield: z.number(),
        })
        .strict(),
    ),
    inventory_bonds: z.array(
      z
        .object({
          bond_name: z.string(),
          tenor_label: z.string(),
          tenor_years: z.number(),
          valuation: z.number(),
          trade_yield: nullableNumber,
          trade_spread_bp: nullableNumber,
          bid_yield: nullableNumber,
          ofr_yield: nullableNumber,
        })
        .strict(),
    ),
  })
  .strict();

export const marketReportSnapshotSchema = reportDataSchema.extend({
  focus_text: z.string(),
  cached_at: isoDateTime,
  finalized_at: isoDateTime.nullable(),
});

export type ReportDataContract = z.infer<typeof reportDataSchema>;
export type MarketReportSnapshotContract = z.infer<
  typeof marketReportSnapshotSchema
>;
export function marketReportObjectKey(reportDate: string): string {
  return `market-briefing/${isoDate.parse(reportDate)}.json`;
}
