export interface MarketMetric {
  label: string;
  value: number | null;
  change: number | null;
  unit: string;
}

export interface OmoPoint {
  day: string;
  net_amount: number | null;
}

export interface OmoOperation {
  operation_date: string;
  operation_name: string;
  duration: string;
  amount_yi: number | null;
  interest_rate: number | null;
}

export interface FundingRate {
  code: string;
  rate: number | null;
  change_bp: number | null;
}

export interface GovernmentBond {
  category: string;
  tenor: string;
  code: string;
  yield_rate: number | null;
  change_bp: number | null;
}

export interface BondFuture {
  code: string;
  last_price: number | null;
  change_pct: number | null;
}

export interface EquityPoint {
  name: string;
  close: number | null;
  change_pct: number | null;
}

export interface IndustryPoint {
  name: string;
  change_pct: number | null;
  market_cap_yuan: number | null;
}

export interface PrimaryIssueDetail {
  issue_date: string;
  issue_date_key: string;
  issuer: string;
  category: string;
  bond_names: string[];
  tenors: string[];
  coupons: Array<number | null>;
  amount: number | null;
}

export interface PrimarySummary {
  current_amount: number | null;
  change_amount: number | null;
}

export interface ComparablePoint {
  issuer: string;
  bond_name: string;
  tenor_years: number;
  trade_yield: number;
}

export interface InventoryPoint {
  bond_name: string;
  tenor_label: string;
  tenor_years: number;
  valuation: number;
  trade_yield: number | null;
  trade_spread_bp: number | null;
  bid_yield?: number | null;
  ofr_yield?: number | null;
}

export interface SecondaryBond extends ComparablePoint {
  bond_id: string;
  tenor_label: string;
  valuation: number | null;
}

export interface MarginSnapshot {
  data_date: string | null;
  total: number | null;
  total_change: number | null;
  financing: number | null;
  financing_change: number | null;
  securities_lending: number | null;
  securities_lending_change: number | null;
}

export interface ReportData {
  report_date: string;
  generated_at: string;
  omo_operations: OmoOperation[];
  funding_rates: FundingRate[];
  government_bonds: GovernmentBond[];
  futures: BondFuture[];
  stock_paragraphs: string[];
  margin: MarginSnapshot;
  equities: EquityPoint[];
  equity_data_time: string | null;
  turnover_yi: number | null;
  turnover_change_yi: number | null;
  industries: IndustryPoint[];
  industry_data_date: string;
  primary_summary: PrimarySummary;
  primary_issues: PrimaryIssueDetail[];
  secondary_bonds: SecondaryBond[];
  inventory_bonds: InventoryPoint[];
}

export interface MarketReportSnapshot extends ReportData {
  focus_text: string;
  cached_at: string;
  finalized_at: string | null;
}

export type MarketReportResource =
  | "omo"
  | "fundingDr"
  | "fundingDibo"
  | "governmentBonds"
  | "futures"
  | "stock"
  | "margin"
  | "industry"
  | "primary"
  | "todayTrades"
  | "favoriteQuotes"
  | "bondInfos";

export interface MarketReportResourceIssue {
  resource: MarketReportResource;
  label: string;
  detail: string;
}

export interface MarketReportLoadResult {
  report: MarketReportSnapshot;
  resourceIssues: MarketReportResourceIssue[];
}

export interface MarketBriefing {
  report_date: string;
  stock: string;
  bond: string;
  news_count: number;
}

export type Row = Record<string, unknown>;
