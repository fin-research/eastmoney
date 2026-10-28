import type { ReportDataContract } from "../../market-report.ts";

/** Only market observations: never include the archived/editor's focus_text. */
export function buildMarketBriefingEvidence(report: ReportDataContract) {
  const currentEquities = report.industry_data_date === report.report_date;
  const industries = currentEquities
    ? report.industries.filter(row => row.change_pct !== null)
      .map(({ name, change_pct }) => ({ name, change_pct }))
      .sort((a, b) => b.change_pct! - a.change_pct!)
    : [];
  return {
    report_date: report.report_date,
    units: { change_pct: "%", change_bp: "bp", amount_yi: "亿元", rate: "%", yield_rate: "%" },
    // Legacy stock_paragraphs have no reliable source timestamp; use dated quotes.
    equities: currentEquities ? report.equities.map(({ name, change_pct }) => ({ name, change_pct })) : [],
    turnover_yi: currentEquities ? report.turnover_yi : null,
    turnover_change_yi: currentEquities ? report.turnover_change_yi : null,
    industry_data_date: report.industry_data_date,
    industry_leaders: industries.slice(0, 3),
    industry_laggards: industries.slice(-3).reverse(),
    funding_rates: report.funding_rates,
    government_bond_directions: {
      prices_up: report.government_bonds.filter(row => row.change_bp !== null && row.change_bp < 0).map(row => `${row.category}${row.tenor}`),
      prices_down: report.government_bonds.filter(row => row.change_bp !== null && row.change_bp > 0).map(row => `${row.category}${row.tenor}`),
      unchanged: report.government_bonds.filter(row => row.change_bp === 0).map(row => `${row.category}${row.tenor}`),
      unknown: report.government_bonds.filter(row => row.change_bp === null).map(row => `${row.category}${row.tenor}`),
    },
    government_bonds: report.government_bonds.map(({ category, tenor, yield_rate, change_bp }) => ({ category, tenor, yield_rate, change_bp })),
    futures: report.futures.map(({ code, change_pct }) => ({ code, change_pct })),
    // Amounts already carry their sign; preserve nulls and operation tenors.
    omo_operations: report.omo_operations.filter(row => row.operation_date === report.report_date),
  };
}
