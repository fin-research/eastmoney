export interface LedgerPerformanceRow {
  date: string;
  principal: number;
  timeWeightedPrincipal: number;
  marketValue: number;
  leverage: number;
  modifiedDuration: number;
  dailyRevenue: number;
  cumulativeProfit: number;
  ytdAnnualizedReturn: number | null;
  ytdExTaxAnnualizedReturn: number | null;
}

export interface LedgerTrendPoint {
  date: string;
  principal: number;
  marketValue: number;
  dailyRevenue: number;
}

export type LedgerTrendAccount = "all" | "trading" | "available";

export interface LedgerAccountDailySummary {
  date: string;
  account: string;
  marketValue: number;
  dailyProfit: number;
  taxExemptIncome: number;
  dv01: number;
  weightedReportYield: number | null;
  reportYieldWeight: number;
}

export interface LedgerOperatingTrendPoint extends LedgerPerformanceRow {
  tradingMarketValue: number;
  availableMarketValue: number;
  flatStatic: number | null;
  dv01: number;
  cumulativeTaxExemptProfit: number | null;
  cumulativeExTaxProfit: number | null;
  fullPoolYtdAnnualizedReturn: number | null;
  fullPoolYtdExTaxAnnualizedReturn: number | null;
}

export interface LedgerPositionRow {
  reportDate: string;
  rowNumber: number;
  team: string;
  investmentManager: string;
  account: string;
  code: string;
  market: string;
  name: string;
  category: string;
  yieldChangeBp: number | null;
  remainingYears: number | null;
  interestStartDate: string | null;
  maturityDate: string | null;
  currentQuantity: number;
  pledgedQuantity: number | null;
  availableQuantity: number | null;
  previousQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  maturityQuantity: number;
  couponRate: number | null;
  valuationYield: number | null;
  reportYield: number | null;
  fullPrice: number | null;
  dv01: number;
  marketValue: number;
  couponIncome: number;
  taxExemptIncome: number;
  realizedProfit: number | null;
  dailyProfit: number;
  ytdProfit: number;
  fullPriceCost: number;
}

export interface ParsedBondLedger {
  date: string;
  performance: LedgerPerformanceRow[];
  positions: LedgerPositionRow[];
}

export type BondLedgerSource = ParsedBondLedger;

export type LedgerTransactionSide = "买入" | "卖出" | "到期";

export interface LedgerTransaction {
  date: string;
  side: LedgerTransactionSide;
  code: string;
  name: string;
  category: string;
  quantity: number;
  faceAmount: number;
  realizedProfit: number | null;
}

export interface LedgerPositionDetail extends LedgerPositionRow {
  rangeProfit: number;
}

export interface HoldingTypeStat {
  category: string;
  marketValue: number;
  share: number;
  weightedYield: number | null;
  weightedRemainingYears: number | null;
  dv01: number;
  dailyProfit: number;
  ytdProfit: number;
  positionCount: number;
}

export interface MaturityBucketStat {
  bucket: string;
  marketValue: number;
  share: number;
  weightedYield: number | null;
  positionCount: number;
}

export interface CoreHolding {
  name: string;
  category: string;
  remainingYears: number | null;
  marketValue: number;
  reportYield: number | null;
}

export interface LedgerAuditCheck {
  key: "scale" | "leverage" | "profit";
  label: string;
  pass: boolean;
  actual: number;
  expected: number;
  difference: number;
  tolerance: number;
}

export interface ReturnRiskMetrics {
  annualizedVolatility: number | null;
  maxDrawdown: number | null;
  validDayCount: number;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
}

export interface LedgerAvailability {
  pledgedQuantity: number | null;
  availableQuantity: number | null;
  pledgedMarketValue: number | null;
  availableMarketValue: number | null;
  /** @deprecated 兼容旧客户端的数量 × 100 元折算，不用于周报展示。 */
  pledgedFaceAmount: number | null;
  /** @deprecated 兼容旧客户端的数量 × 100 元折算，不用于周报展示。 */
  availableFaceAmount: number | null;
}

export interface BondLedgerAnalytics {
  selectedLedgers: BondLedgerSource[];
  latestLedger: BondLedgerSource | null;
  currentPerformance: LedgerPerformanceRow | null;
  performanceTrend: LedgerPerformanceRow[];
  operatingTrend: LedgerOperatingTrendPoint[];
  accountPerformanceTrends: Record<
    Exclude<LedgerTrendAccount, "all">,
    LedgerTrendPoint[]
  >;
  rangePerformance: LedgerPerformanceRow[];
  currentPositions: LedgerPositionDetail[];
  holdingTypes: HoldingTypeStat[];
  maturityBuckets: MaturityBucketStat[];
  tradingHoldingTypes: HoldingTypeStat[];
  tradingMaturityBuckets: MaturityBucketStat[];
  topTradingPositions: CoreHolding[];
  transactions: LedgerTransaction[];
  transactionTotals: Record<LedgerTransactionSide, number>;
  rangeProfit: number | null;
  rangeAnnualizedReturn: number | null;
  ytdAnnualizedReturn: number | null;
  returnRiskMetrics: ReturnRiskMetrics;
  transactionCount: number;
  metricDeltas: {
    marketValue: number | null;
    leverage: number | null;
    modifiedDuration: number | null;
    ytdAnnualizedReturn: number | null;
    reportedYtdAnnualizedReturn: number | null;
    reportedYtdExTaxAnnualizedReturn: number | null;
    annualizedVolatility: number | null;
    rangeProfit: number | null;
    transactionCount: number | null;
  };
  detailMarketValue: number;
  availability: LedgerAvailability;
  reconciliationGap: number | null;
  auditChecks: LedgerAuditCheck[];
  auditPassed: boolean;
  effectiveStartDate: string | null;
  effectiveEndDate: string | null;
}

export interface BondLedgerReport {
  hasData: boolean;
  currentPerformance: LedgerPerformanceRow | null;
  performanceTrend: LedgerPerformanceRow[];
  operatingTrend: LedgerOperatingTrendPoint[];
  accountPerformanceTrends: BondLedgerAnalytics["accountPerformanceTrends"];
  holdingTypes: HoldingTypeStat[];
  maturityBuckets: MaturityBucketStat[];
  tradingHoldingTypes: HoldingTypeStat[];
  tradingMaturityBuckets: MaturityBucketStat[];
  topTradingPositions: CoreHolding[];
  transactions: LedgerTransaction[];
  transactionTotals: Record<LedgerTransactionSide, number>;
  rangeProfit: number | null;
  rangeAnnualizedReturn: number | null;
  ytdAnnualizedReturn: number | null;
  returnRiskMetrics: ReturnRiskMetrics;
  transactionCount: number;
  metricDeltas: BondLedgerAnalytics["metricDeltas"];
  detailMarketValue: number;
  availability: LedgerAvailability;
  auditChecks: LedgerAuditCheck[];
  auditPassed: boolean;
  effectiveStartDate: string | null;
  effectiveEndDate: string | null;
}
