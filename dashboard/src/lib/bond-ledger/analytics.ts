import type {
  BondLedgerAnalytics,
  BondLedgerReport,
  BondLedgerSource,
  CoreHolding,
  HoldingTypeStat,
  LedgerAccountDailySummary,
  LedgerAvailability,
  LedgerAuditCheck,
  LedgerOperatingTrendPoint,
  LedgerPerformanceRow,
  LedgerPositionDetail,
  LedgerPositionRow,
  LedgerTrendPoint,
  LedgerTransaction,
  LedgerTransactionSide,
  MaturityBucketStat,
  ReturnRiskMetrics,
} from "./types";

const DAY_MS = 86_400_000;
const BUSINESS_TRADING_DAYS = 252;
const TRANSACTION_SIDES: Array<{
  side: LedgerTransactionSide;
  field: "buyQuantity" | "sellQuantity" | "maturityQuantity";
}> = [
  { side: "买入", field: "buyQuantity" },
  { side: "卖出", field: "sellQuantity" },
  { side: "到期", field: "maturityQuantity" },
];

const MATURITY_BUCKETS = [
  { bucket: "0-3月", min: 0, max: 0.25 },
  { bucket: "3-6月", min: 0.25, max: 0.5 },
  { bucket: "6-12月", min: 0.5, max: 1 },
  { bucket: "1-2年", min: 1, max: 2 },
  { bucket: "2-3年", min: 2, max: 3 },
  { bucket: "3-5年", min: 3, max: 5 },
  { bucket: "5-10年", min: 5, max: 10 },
  { bucket: "10年以上", min: 10, max: Number.POSITIVE_INFINITY },
] as const;

const WEEKLY_REPORT_MATURITY_BUCKETS = [
  { bucket: "1月以内", min: 0, max: 1 / 12, maxInclusive: true },
  { bucket: "1-3月", min: 1 / 12, max: 0.25, minExclusive: true, maxInclusive: true },
  { bucket: "3-6月", min: 0.25, max: 0.5, minExclusive: true, maxInclusive: true },
  { bucket: "6-9月", min: 0.5, max: 0.75, minExclusive: true, maxInclusive: true },
  { bucket: "9-12月", min: 0.75, max: 1, minExclusive: true, maxInclusive: true },
  { bucket: "1-3年", min: 1, max: 3, minExclusive: true, maxInclusive: true },
  { bucket: "3-5年", min: 3, max: 5, minExclusive: true, maxInclusive: true },
  { bucket: "5年以上", min: 5, max: Number.POSITIVE_INFINITY, minExclusive: true },
] as const;

export function buildBondLedgerAnalytics(
  ledgers: BondLedgerSource[],
  startDate: string,
  endDate: string,
  storedTransactions?: LedgerTransaction[],
  storedAccountDailySummaries?: LedgerAccountDailySummary[],
): BondLedgerAnalytics {
  const selectedLedgers = ledgers
    .filter((ledger) => ledger.date >= startDate && ledger.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const latestLedger = selectedLedgers.at(-1) ?? null;
  if (!latestLedger) return emptyAnalytics(selectedLedgers);

  const currentPerformance =
    latestLedger.performance.find((row) => row.date === latestLedger.date) ??
    latestLedger.performance.filter((row) => row.date <= latestLedger.date).at(-1) ??
    null;
  const effectiveEndDate = currentPerformance?.date ?? latestLedger.date;
  const effectiveStartDate = startDate <= effectiveEndDate ? startDate : null;
  const rangePerformance = effectiveStartDate
    ? latestLedger.performance.filter(
        (row) => row.date >= effectiveStartDate && row.date <= effectiveEndDate,
      )
    : [];
  const currentPositionRows = latestLedger.positions.filter(
    (row) => row.currentQuantity > 0 || row.marketValue > 0,
  );
  const currentPositions = addRangeProfit(
    currentPositionRows,
    selectedLedgers,
  );
  const detailMarketValue = sum(currentPositions.map((row) => row.marketValue));
  const tradingPositions = currentPositions.filter(
    (position) => accountType(position.account) === "trading",
  );
  const tradingMarketValue = sum(
    tradingPositions.map((position) => position.marketValue),
  );
  const transactions = (storedTransactions
    ? storedTransactions.filter(
        (transaction) =>
          transaction.date >= startDate && transaction.date <= endDate,
      )
    : selectedLedgers.flatMap((ledger) => transactionsForLedger(ledger)))
    .sort((left, right) => {
      const dateOrder = right.date.localeCompare(left.date);
      return dateOrder || right.faceAmount - left.faceAmount;
    });
  const transactionTotals = transactionTotalMap(transactions);
  const rangeProfit = effectiveStartDate
    ? calculateRangeProfit(
        latestLedger.performance,
        effectiveStartDate,
        effectiveEndDate,
      )
    : null;
  const rangeAnnualizedReturn =
    effectiveStartDate && rangeProfit !== null
      ? calculateRangeAnnualizedReturn(
          latestLedger.performance,
          effectiveStartDate,
          effectiveEndDate,
          rangeProfit,
        )
      : null;
  const ytdAnnualizedReturn = calculateBusinessAnnualizedReturn(
    latestLedger.performance,
    effectiveEndDate,
  );
  const returnRiskMetrics = effectiveStartDate
    ? calculateReturnRiskMetrics(
        latestLedger.performance,
        effectiveStartDate,
        effectiveEndDate,
      )
    : emptyReturnRiskMetrics();
  const accountDailySummaries =
    storedAccountDailySummaries ?? summarizeAccountPositions(ledgers);
  const accountPerformanceTrends = buildAccountPerformanceTrends(
    latestLedger.performance.filter((row) => row.date <= effectiveEndDate),
    ledgers,
    accountDailySummaries,
  );
  const operatingTrend = buildOperatingTrend(
    latestLedger.performance.filter((row) => row.date <= effectiveEndDate),
    accountDailySummaries,
  );
  const comparisonStartDate = effectiveStartDate
    ? addDays(effectiveStartDate, -7)
    : null;
  const comparisonEndDate = addDays(effectiveEndDate, -7);
  const previousPerformance = comparisonEndDate
    ? latestLedger.performance
        .filter((row) => row.date <= comparisonEndDate)
        .at(-1) ?? null
    : null;
  const previousRangeProfit =
    comparisonStartDate && comparisonEndDate
      ? calculateRangeProfit(
          latestLedger.performance,
          comparisonStartDate,
          comparisonEndDate,
        )
      : null;
  const previousReturnRiskMetrics =
    comparisonStartDate && comparisonEndDate
      ? calculateReturnRiskMetrics(
          latestLedger.performance,
          comparisonStartDate,
          comparisonEndDate,
        )
      : emptyReturnRiskMetrics();
  const previousTransactions =
    comparisonStartDate && comparisonEndDate
      ? storedTransactions
        ? storedTransactions.filter(
            (transaction) =>
              transaction.date >= comparisonStartDate &&
              transaction.date <= comparisonEndDate,
          )
        : ledgers
            .filter(
              (ledger) =>
                ledger.date >= comparisonStartDate &&
                ledger.date <= comparisonEndDate,
            )
            .flatMap((ledger) => transactionsForLedger(ledger))
      : [];
  const transactionCount = uniqueTransactionCount(transactions);
  const previousTransactionCount = uniqueTransactionCount(previousTransactions);
  const auditChecks = buildAuditChecks(
    currentPerformance,
    latestLedger.positions,
  );

  return {
    selectedLedgers,
    latestLedger,
    currentPerformance,
    performanceTrend: latestLedger.performance.filter(
      (row) => row.date <= effectiveEndDate,
    ),
    operatingTrend,
    accountPerformanceTrends,
    rangePerformance,
    currentPositions: currentPositions.sort(
      (left, right) => right.marketValue - left.marketValue,
    ),
    holdingTypes: aggregateHoldingTypes(currentPositions, detailMarketValue),
    maturityBuckets: aggregateMaturityBuckets(
      currentPositions,
      detailMarketValue,
    ),
    tradingHoldingTypes: aggregateHoldingTypes(
      tradingPositions,
      tradingMarketValue,
    ),
    tradingMaturityBuckets: aggregateMaturityBucketsByDefinition(
      tradingPositions,
      tradingMarketValue,
      WEEKLY_REPORT_MATURITY_BUCKETS,
    ),
    topTradingPositions: toCoreHoldings(tradingPositions),
    transactions,
    transactionTotals,
    rangeProfit,
    rangeAnnualizedReturn,
    ytdAnnualizedReturn,
    returnRiskMetrics,
    transactionCount,
    metricDeltas: {
      marketValue: difference(
        currentPerformance?.marketValue,
        previousPerformance?.marketValue,
      ),
      leverage: difference(
        currentPerformance?.leverage,
        previousPerformance?.leverage,
      ),
      modifiedDuration: difference(
        currentPerformance?.modifiedDuration,
        previousPerformance?.modifiedDuration,
      ),
      ytdAnnualizedReturn: difference(
        ytdAnnualizedReturn,
        comparisonEndDate
          ? calculateBusinessAnnualizedReturn(
              latestLedger.performance,
              comparisonEndDate,
            )
          : null,
      ),
      reportedYtdAnnualizedReturn: difference(
        currentPerformance?.ytdAnnualizedReturn,
        previousPerformance?.ytdAnnualizedReturn,
      ),
      reportedYtdExTaxAnnualizedReturn: difference(
        currentPerformance?.ytdExTaxAnnualizedReturn,
        previousPerformance?.ytdExTaxAnnualizedReturn,
      ),
      annualizedVolatility: difference(
        returnRiskMetrics.annualizedVolatility,
        previousReturnRiskMetrics.annualizedVolatility,
      ),
      rangeProfit: difference(rangeProfit, previousRangeProfit),
      transactionCount:
        previousTransactions.length || transactionCount
          ? transactionCount - previousTransactionCount
          : null,
    },
    detailMarketValue,
    availability: summarizePositionAvailability(currentPositionRows),
    reconciliationGap:
      currentPerformance && currentPerformance.marketValue !== 0
        ? (detailMarketValue - currentPerformance.marketValue) /
          currentPerformance.marketValue
        : null,
    auditChecks,
    auditPassed: auditChecks.length === 3 && auditChecks.every((check) => check.pass),
    effectiveStartDate,
    effectiveEndDate,
  };
}

export function toBondLedgerReport(
  analytics: BondLedgerAnalytics,
): BondLedgerReport {
  return {
    hasData: analytics.latestLedger !== null,
    currentPerformance: analytics.currentPerformance,
    performanceTrend: analytics.performanceTrend,
    operatingTrend: analytics.operatingTrend,
    accountPerformanceTrends: analytics.accountPerformanceTrends,
    holdingTypes: analytics.holdingTypes,
    maturityBuckets: analytics.maturityBuckets,
    tradingHoldingTypes: analytics.tradingHoldingTypes,
    tradingMaturityBuckets: analytics.tradingMaturityBuckets,
    topTradingPositions: analytics.topTradingPositions,
    transactions: analytics.transactions,
    transactionTotals: analytics.transactionTotals,
    rangeProfit: analytics.rangeProfit,
    rangeAnnualizedReturn: analytics.rangeAnnualizedReturn,
    ytdAnnualizedReturn: analytics.ytdAnnualizedReturn,
    returnRiskMetrics: analytics.returnRiskMetrics,
    transactionCount: analytics.transactionCount,
    metricDeltas: analytics.metricDeltas,
    detailMarketValue: analytics.detailMarketValue,
    availability: analytics.availability,
    auditChecks: analytics.auditChecks,
    auditPassed: analytics.auditPassed,
    effectiveStartDate: analytics.effectiveStartDate,
    effectiveEndDate: analytics.effectiveEndDate,
  };
}

export function emptyBondLedgerReport(): BondLedgerReport {
  return toBondLedgerReport(emptyAnalytics([]));
}

export function summarizePositionAvailability(
  positions: LedgerPositionRow[],
): LedgerAvailability {
  // 只汇总有持仓的券；任一持仓缺少字段时不把部分汇总冒充全池金额。
  const holdings = positions.filter((row) => row.currentQuantity > 0 || row.marketValue > 0);
  if (!holdings.length || holdings.some((row) =>
    row.pledgedQuantity == null || row.availableQuantity == null
  )) {
    return {
      pledgedQuantity: null, availableQuantity: null,
      pledgedMarketValue: null, availableMarketValue: null,
      pledgedFaceAmount: null, availableFaceAmount: null,
    };
  }
  const pledgedQuantity = sum(holdings.map((row) => row.pledgedQuantity as number));
  const availableQuantity = sum(holdings.map((row) => row.availableQuantity as number));
  // 使用原表全价市值按单券数量占比分拆，兼容估值全价为空或为零的 ETF。
  // 有市值却没有有效持仓数量时无法分拆，不输出部分汇总或无穷值。
  const canSplitMarketValue = holdings.every((row) =>
    Number.isFinite(row.currentQuantity) && row.currentQuantity > 0 &&
    Number.isFinite(row.marketValue) && row.marketValue >= 0
  );
  return {
    pledgedQuantity,
    availableQuantity,
    pledgedMarketValue: canSplitMarketValue
      ? sum(holdings.map((row) => row.marketValue * ((row.pledgedQuantity as number) / row.currentQuantity)))
      : null,
    availableMarketValue: canSplitMarketValue
      ? sum(holdings.map((row) => row.marketValue * ((row.availableQuantity as number) / row.currentQuantity)))
      : null,
    pledgedFaceAmount: pledgedQuantity * 100,
    availableFaceAmount: availableQuantity * 100,
  };
}

export function weekRange(referenceDate: string): {
  startDate: string;
  endDate: string;
} {
  const date = parseIsoDate(referenceDate);
  const weekday = date.getUTCDay() || 7;
  const monday = new Date(date.valueOf() - (weekday - 1) * DAY_MS);
  return {
    startDate: monday.toISOString().slice(0, 10),
    endDate: referenceDate,
  };
}

export function previousBusinessWeekRange(referenceDate: string): {
  startDate: string;
  endDate: string;
} {
  const currentWeek = weekRange(referenceDate);
  return {
    startDate: addDays(currentWeek.startDate, -7),
    endDate: addDays(currentWeek.startDate, -3),
  };
}

export function isoWeek(value: string): { year: number; week: number } {
  const date = parseIsoDate(value);
  const weekday = date.getUTCDay() || 7;
  const thursday = new Date(date.valueOf() + (4 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstWeekday = firstThursday.getUTCDay() || 7;
  const firstWeekThursday = new Date(
    firstThursday.valueOf() + (4 - firstWeekday) * DAY_MS,
  );
  return {
    year,
    week: Math.round((thursday.valueOf() - firstWeekThursday.valueOf()) / (7 * DAY_MS)) + 1,
  };
}

export function calculateBusinessAnnualizedReturn(
  performance: LedgerPerformanceRow[],
  throughDate?: string,
): number | null {
  return calculateBusinessAnnualizedReturnTrend(performance, throughDate)
    .map((point) => point.value)
    .filter((value): value is number => value !== null)
    .at(-1) ?? null;
}

export function calculateBusinessAnnualizedReturnTrend(
  performance: LedgerTrendPoint[],
  throughDate?: string,
): Array<{ date: string; value: number | null }> {
  let dailyReturnSum = 0;
  let tradingDayCount = 0;
  let activeYear = "";
  return performance
    .filter((row) => !throughDate || row.date <= throughDate)
    .map((row) => {
      const year = row.date.slice(0, 4);
      if (year !== activeYear) {
        activeYear = year;
        dailyReturnSum = 0;
        tradingDayCount = 0;
      }
      if (row.principal > 0 && Number.isFinite(row.dailyRevenue)) {
        dailyReturnSum += row.dailyRevenue / row.principal;
        tradingDayCount += 1;
      }
      return {
        date: row.date,
        value:
          tradingDayCount > 0
            ? (dailyReturnSum / tradingDayCount) * BUSINESS_TRADING_DAYS
            : null,
      };
    });
}

export function calculateReturnRiskMetrics(
  performance: LedgerPerformanceRow[],
  startDate: string,
  endDate: string,
): ReturnRiskMetrics {
  const dailyReturns = performance
    .filter((row) => row.date >= startDate && row.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .flatMap((row) => {
      if (row.principal <= 0 || !Number.isFinite(row.dailyRevenue)) return [];
      const value = row.dailyRevenue / row.principal;
      return Number.isFinite(value) && value > -1
        ? [{ date: row.date, value }]
        : [];
    });
  if (!dailyReturns.length) return emptyReturnRiskMetrics();

  const validDayCount = dailyReturns.length;
  const meanDailyReturn =
    sum(dailyReturns.map(({ value }) => value)) / validDayCount;
  const annualizedVolatility =
    validDayCount >= 2
      ? sampleStandardDeviation(
          dailyReturns.map(({ value }) => value),
          meanDailyReturn,
        ) * Math.sqrt(BUSINESS_TRADING_DAYS)
      : null;
  let wealth = 1;
  let peak = 1;
  let peakDate: string | null = null;
  let maxDrawdown = 0;
  let maxDrawdownPeakDate: string | null = null;
  let maxDrawdownTroughDate: string | null = null;
  for (const point of dailyReturns) {
    wealth *= 1 + point.value;
    if (wealth >= peak) {
      peak = wealth;
      peakDate = point.date;
      continue;
    }
    const drawdown = (peak - wealth) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPeakDate = peakDate;
      maxDrawdownTroughDate = point.date;
    }
  }

  return {
    annualizedVolatility,
    maxDrawdown,
    validDayCount,
    maxDrawdownPeakDate,
    maxDrawdownTroughDate,
  };
}

export function buildAccountPerformanceTrends(
  performance: LedgerPerformanceRow[],
  ledgers: BondLedgerSource[],
  storedSummaries?: LedgerAccountDailySummary[],
): BondLedgerAnalytics["accountPerformanceTrends"] {
  const summaries = storedSummaries ?? summarizeAccountPositions(ledgers);
  const summariesByDate = new Map<string, LedgerAccountDailySummary[]>();
  for (const summary of summaries) {
    const rows = summariesByDate.get(summary.date) ?? [];
    rows.push(summary);
    summariesByDate.set(summary.date, rows);
  }
  const availableStartDate = summaries
    .filter((summary) => accountType(summary.account) === "available")
    .map((summary) => summary.date)
    .sort()
    .at(0) ?? null;
  const trading: LedgerTrendPoint[] = [];
  const available: LedgerTrendPoint[] = [];

  for (const row of performance) {
    const dailySummaries = summariesByDate.get(row.date) ?? [];
    const tradingSummary = dailySummaries.find(
      (summary) => accountType(summary.account) === "trading",
    );
    const availableSummary = dailySummaries.find(
      (summary) => accountType(summary.account) === "available",
    );

    if (!availableStartDate) {
      trading.push(toTrendPoint(row));
      continue;
    }
    if (row.date < availableStartDate) {
      trading.push(toTrendPoint(row));
      available.push({
        date: row.date,
        principal: row.principal,
        marketValue: 0,
        dailyRevenue: 0,
      });
      continue;
    }
    if (tradingSummary) {
      trading.push(accountTrendPoint(row, tradingSummary));
    }
    if (availableSummary) {
      available.push(accountTrendPoint(row, availableSummary));
    }
  }

  return { trading, available };
}

export function buildOperatingTrend(
  performance: LedgerPerformanceRow[],
  summaries: LedgerAccountDailySummary[],
): LedgerOperatingTrendPoint[] {
  const summariesByDate = new Map<string, LedgerAccountDailySummary[]>();
  for (const summary of summaries) {
    const rows = summariesByDate.get(summary.date) ?? [];
    rows.push(summary);
    summariesByDate.set(summary.date, rows);
  }

  let activeYear = "";
  let cumulativeTaxExemptProfit = 0;
  let carriedTaxExemptProfit: number | null = null;
  let taxExemptCoverageComplete = true;
  return performance
    .filter((row) => row.date.slice(5) !== "01-01")
    .map((row) => {
      const year = row.date.slice(0, 4);
      if (year !== activeYear) {
        activeYear = year;
        cumulativeTaxExemptProfit = 0;
        carriedTaxExemptProfit = null;
        taxExemptCoverageComplete = true;
      }
      const dailySummaries = summariesByDate.get(row.date) ?? [];
      if (!dailySummaries.length) {
        taxExemptCoverageComplete = false;
      } else {
        cumulativeTaxExemptProfit += sum(
          dailySummaries.map((summary) => summary.taxExemptIncome),
        );
      }
      const tradingMarketValue = sum(
        dailySummaries
          .filter((summary) => accountType(summary.account) === "trading")
          .map((summary) => summary.marketValue),
      );
      const availableMarketValue = sum(
        dailySummaries
          .filter((summary) => accountType(summary.account) === "available")
          .map((summary) => summary.marketValue),
      );
      const yieldSummaries = dailySummaries.filter(
        (summary) =>
          summary.weightedReportYield !== null && summary.reportYieldWeight > 0,
      );
      const yieldWeight = sum(
        yieldSummaries.map((summary) => summary.reportYieldWeight),
      );
      const flatStatic =
        yieldWeight > 0
          ? sum(
              yieldSummaries.map(
                (summary) =>
                  (summary.weightedReportYield as number) *
                  summary.reportYieldWeight,
              ),
            ) / yieldWeight
          : null;
      const annualizationDays = daysBetween(`${year}-01-01`, row.date);
      const derivedFullPoolReturn = annualizeCumulativeProfit(
        row.cumulativeProfit,
        row.timeWeightedPrincipal,
        annualizationDays,
      );
      const reportedReturnIsFullPool = approximatelyEqual(
        row.ytdAnnualizedReturn,
        derivedFullPoolReturn,
      );
      const reportedExTaxProfit = reportedReturnIsFullPool
        ? deannualizeCumulativeReturn(
            row.ytdExTaxAnnualizedReturn,
            row.timeWeightedPrincipal,
            annualizationDays,
          )
        : null;
      const dailyTaxExemptIncome = sum(
        dailySummaries.map((summary) => summary.taxExemptIncome),
      );
      if (reportedExTaxProfit !== null) {
        carriedTaxExemptProfit = row.cumulativeProfit - reportedExTaxProfit;
      } else if (carriedTaxExemptProfit !== null && dailySummaries.length) {
        carriedTaxExemptProfit += dailyTaxExemptIncome;
      }
      const cumulativeExTaxProfit =
        reportedExTaxProfit ??
        (carriedTaxExemptProfit !== null
          ? row.cumulativeProfit - carriedTaxExemptProfit
          : null) ??
        (taxExemptCoverageComplete
          ? row.cumulativeProfit - cumulativeTaxExemptProfit
          : null);
      if (cumulativeExTaxProfit !== null) {
        carriedTaxExemptProfit = row.cumulativeProfit - cumulativeExTaxProfit;
      }
      const fullPoolYtdExTaxAnnualizedReturn =
        cumulativeExTaxProfit === null
          ? null
          : annualizeCumulativeProfit(
              cumulativeExTaxProfit,
              row.timeWeightedPrincipal,
              annualizationDays,
            );

      return {
        ...row,
        tradingMarketValue,
        availableMarketValue,
        flatStatic,
        dv01: sum(dailySummaries.map((summary) => summary.dv01)),
        cumulativeTaxExemptProfit:
          cumulativeExTaxProfit === null
            ? null
            : row.cumulativeProfit - cumulativeExTaxProfit,
        cumulativeExTaxProfit,
        fullPoolYtdAnnualizedReturn: derivedFullPoolReturn,
        fullPoolYtdExTaxAnnualizedReturn,
      };
    });
}

function calculateRangeProfit(
  performance: LedgerPerformanceRow[],
  startDate: string,
  endDate: string,
): number | null {
  const end = performance.filter((row) => row.date <= endDate).at(-1);
  if (!end || end.date < startDate) return null;
  const base = performance.filter((row) => row.date < startDate).at(-1);
  return end.cumulativeProfit - (base?.cumulativeProfit ?? 0);
}

function calculateRangeAnnualizedReturn(
  performance: LedgerPerformanceRow[],
  startDate: string,
  endDate: string,
  rangeProfit: number,
): number | null {
  const dayCount = daysBetween(startDate, endDate) + 1;
  if (dayCount <= 0) return null;
  const capitalDays = calculateCapitalDays(performance, startDate, endDate);
  if (capitalDays <= 0) return null;
  const averagePrincipal = capitalDays / dayCount;
  return (rangeProfit / averagePrincipal) * (365 / dayCount);
}

function calculateCapitalDays(
  performance: LedgerPerformanceRow[],
  startDate: string,
  endDate: string,
): number {
  let capitalDays = 0;
  let cursor = parseIsoDate(startDate);
  const last = parseIsoDate(endDate);
  let rowIndex = Math.max(
    0,
    performance.findIndex((row) => row.date >= startDate),
  );
  if (rowIndex > 0 && (performance[rowIndex]?.date ?? "") > startDate) {
    rowIndex -= 1;
  }
  while (cursor <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    while (
      rowIndex + 1 < performance.length &&
      (performance[rowIndex + 1]?.date ?? "") <= iso
    ) {
      rowIndex += 1;
    }
    const row = performance[rowIndex];
    if (row && row.date <= iso) capitalDays += row.principal;
    cursor = new Date(cursor.valueOf() + DAY_MS);
  }
  return capitalDays;
}

function aggregateHoldingTypes(
  positions: LedgerPositionRow[],
  totalMarketValue: number,
): HoldingTypeStat[] {
  const groups = new Map<
    string,
    {
      marketValue: number;
      yieldValue: number;
      yieldWeight: number;
      remainingValue: number;
      remainingWeight: number;
      dv01: number;
      dailyProfit: number;
      ytdProfit: number;
      positionCount: number;
    }
  >();
  for (const row of positions) {
    const group = groups.get(row.category) ?? {
      marketValue: 0,
      yieldValue: 0,
      yieldWeight: 0,
      remainingValue: 0,
      remainingWeight: 0,
      dv01: 0,
      dailyProfit: 0,
      ytdProfit: 0,
      positionCount: 0,
    };
    group.marketValue += row.marketValue;
    group.dv01 += row.dv01;
    group.dailyProfit += row.dailyProfit;
    group.ytdProfit += row.ytdProfit;
    group.positionCount += 1;
    if (row.reportYield !== null && row.reportYield > 0 && row.marketValue > 0) {
      group.yieldValue += row.reportYield * row.marketValue;
      group.yieldWeight += row.marketValue;
    }
    if (
      row.remainingYears !== null &&
      row.remainingYears >= 0 &&
      row.marketValue > 0
    ) {
      group.remainingValue += row.remainingYears * row.marketValue;
      group.remainingWeight += row.marketValue;
    }
    groups.set(row.category, group);
  }
  return [...groups.entries()]
    .map(([category, group]) => ({
      category,
      marketValue: group.marketValue,
      share: totalMarketValue > 0 ? group.marketValue / totalMarketValue : 0,
      weightedYield:
        group.yieldWeight > 0 ? group.yieldValue / group.yieldWeight : null,
      weightedRemainingYears:
        group.remainingWeight > 0
          ? group.remainingValue / group.remainingWeight
          : null,
      dv01: group.dv01,
      dailyProfit: group.dailyProfit,
      ytdProfit: group.ytdProfit,
      positionCount: group.positionCount,
    }))
    .sort((left, right) => right.marketValue - left.marketValue);
}

function aggregateMaturityBuckets(
  positions: LedgerPositionRow[],
  totalMarketValue: number,
): MaturityBucketStat[] {
  return aggregateMaturityBucketsByDefinition(
    positions,
    totalMarketValue,
    MATURITY_BUCKETS,
  );
}

function aggregateMaturityBucketsByDefinition(
  positions: LedgerPositionRow[],
  totalMarketValue: number,
  definitions: ReadonlyArray<{
    bucket: string;
    min: number;
    max: number;
    minExclusive?: boolean;
    maxInclusive?: boolean;
  }>,
): MaturityBucketStat[] {
  return definitions.map(({ bucket, min, max, minExclusive, maxInclusive }) => {
    const members = positions.filter((row) => {
      const remaining = row.remainingYears;
      return (
        remaining !== null &&
        (minExclusive ? remaining > min : remaining >= min) &&
        (maxInclusive ? remaining <= max : remaining < max)
      );
    });
    const marketValue = sum(members.map((row) => row.marketValue));
    const yieldMembers = members.filter(
      (row) => row.reportYield !== null && row.reportYield > 0 && row.marketValue > 0,
    );
    const yieldWeight = sum(yieldMembers.map((row) => row.marketValue));
    return {
      bucket,
      marketValue,
      share: totalMarketValue > 0 ? marketValue / totalMarketValue : 0,
      weightedYield:
        yieldWeight > 0
          ? sum(
              yieldMembers.map(
                (row) => (row.reportYield as number) * row.marketValue,
              ),
            ) / yieldWeight
          : null,
      positionCount: members.length,
    };
  });
}

function toCoreHoldings(positions: LedgerPositionDetail[]): CoreHolding[] {
  return positions
    .filter((position) => position.marketValue > 0)
    .sort((left, right) => right.marketValue - left.marketValue)
    .slice(0, 5)
    .map((position) => ({
      name: position.name,
      category: position.category,
      remainingYears: position.remainingYears,
      marketValue: position.marketValue,
      reportYield: position.reportYield,
    }));
}

function buildAuditChecks(
  performance: LedgerPerformanceRow | null,
  positions: LedgerPositionRow[],
): LedgerAuditCheck[] {
  if (!performance) return [];
  const detailMarketValue = sum(positions.map((position) => position.marketValue));
  const calculatedLeverage =
    performance.principal > 0
      ? detailMarketValue / performance.principal
      : Number.NaN;
  const detailDailyProfit = sum(
    positions.map((position) => position.dailyProfit),
  );
  return [
    auditCheck(
      "scale",
      "交易户与可供户市值合计",
      detailMarketValue,
      performance.marketValue,
      1,
    ),
    auditCheck(
      "leverage",
      "持仓规模除以业务本金",
      calculatedLeverage,
      performance.leverage,
      0.000001,
    ),
    auditCheck(
      "profit",
      "交易户与可供户当日损益合计",
      detailDailyProfit,
      performance.dailyRevenue,
      1,
    ),
  ];
}

function auditCheck(
  key: LedgerAuditCheck["key"],
  label: string,
  actual: number,
  expected: number,
  tolerance: number,
): LedgerAuditCheck {
  const difference = actual - expected;
  return {
    key,
    label,
    pass: Number.isFinite(difference) && Math.abs(difference) <= tolerance,
    actual,
    expected,
    difference,
    tolerance,
  };
}

function transactionsForLedger(ledger: BondLedgerSource): LedgerTransaction[] {
  const transactions: LedgerTransaction[] = [];
  for (const row of ledger.positions) {
    for (const { side, field } of TRANSACTION_SIDES) {
      const quantity = row[field];
      if (quantity <= 0) continue;
      transactions.push({
        date: ledger.date,
        side,
        code: row.code,
        name: row.name,
        category: row.category,
        quantity,
        faceAmount: quantity * 100,
        realizedProfit: side === "买入" ? null : row.realizedProfit,
      });
    }
  }
  return transactions.sort((left, right) => {
    const dateOrder = right.date.localeCompare(left.date);
    return dateOrder || right.faceAmount - left.faceAmount;
  });
}

function transactionTotalMap(
  transactions: LedgerTransaction[],
): Record<LedgerTransactionSide, number> {
  const totals: Record<LedgerTransactionSide, number> = {
    买入: 0,
    卖出: 0,
    到期: 0,
  };
  for (const transaction of transactions) {
    totals[transaction.side] += transaction.faceAmount;
  }
  return totals;
}

function emptyAnalytics(
  selectedLedgers: BondLedgerSource[],
): BondLedgerAnalytics {
  return {
    selectedLedgers,
    latestLedger: null,
    currentPerformance: null,
    performanceTrend: [],
    operatingTrend: [],
    accountPerformanceTrends: { trading: [], available: [] },
    rangePerformance: [],
    currentPositions: [],
    holdingTypes: [],
    maturityBuckets: [],
    tradingHoldingTypes: [],
    tradingMaturityBuckets: [],
    topTradingPositions: [],
    transactions: [],
    transactionTotals: { 买入: 0, 卖出: 0, 到期: 0 },
    rangeProfit: null,
    rangeAnnualizedReturn: null,
    ytdAnnualizedReturn: null,
    returnRiskMetrics: emptyReturnRiskMetrics(),
    transactionCount: 0,
    metricDeltas: {
      marketValue: null,
      leverage: null,
      modifiedDuration: null,
      ytdAnnualizedReturn: null,
      reportedYtdAnnualizedReturn: null,
      reportedYtdExTaxAnnualizedReturn: null,
      annualizedVolatility: null,
      rangeProfit: null,
      transactionCount: null,
    },
    detailMarketValue: 0,
    availability: summarizePositionAvailability([]),
    reconciliationGap: null,
    auditChecks: [],
    auditPassed: false,
    effectiveStartDate: null,
    effectiveEndDate: null,
  };
}

function emptyReturnRiskMetrics(): ReturnRiskMetrics {
  return {
    annualizedVolatility: null,
    maxDrawdown: null,
    validDayCount: 0,
    maxDrawdownPeakDate: null,
    maxDrawdownTroughDate: null,
  };
}

function accountTrendPoint(
  performance: LedgerPerformanceRow,
  summary: LedgerAccountDailySummary,
): LedgerTrendPoint {
  return {
    date: performance.date,
    principal: performance.principal,
    marketValue: summary.marketValue,
    dailyRevenue: summary.dailyProfit,
  };
}

function summarizeAccountPositions(
  ledgers: BondLedgerSource[],
): LedgerAccountDailySummary[] {
  const summaries = new Map<string, LedgerAccountDailySummary>();
  for (const ledger of ledgers) {
    for (const position of ledger.positions) {
      const key = `${ledger.date}\u0000${position.account}`;
      const summary = summaries.get(key) ?? {
        date: ledger.date,
        account: position.account,
        marketValue: 0,
        dailyProfit: 0,
        taxExemptIncome: 0,
        dv01: 0,
        weightedReportYield: null,
        reportYieldWeight: 0,
      };
      summary.marketValue += position.marketValue;
      summary.dailyProfit += position.dailyProfit;
      summary.taxExemptIncome += position.taxExemptIncome;
      summary.dv01 += position.dv01;
      if (position.marketValue > 0) {
        const weightedYieldTotal =
          (summary.weightedReportYield ?? 0) * summary.reportYieldWeight +
          (position.reportYield ?? 0) * position.marketValue;
        summary.reportYieldWeight += position.marketValue;
        summary.weightedReportYield =
          weightedYieldTotal / summary.reportYieldWeight;
      }
      summaries.set(key, summary);
    }
  }
  return [...summaries.values()];
}

function toTrendPoint(performance: LedgerPerformanceRow): LedgerTrendPoint {
  return {
    date: performance.date,
    principal: performance.principal,
    marketValue: performance.marketValue,
    dailyRevenue: performance.dailyRevenue,
  };
}

function accountType(account: string): "trading" | "available" | null {
  const normalized = account.replaceAll(" ", "");
  if (normalized.endsWith("交易户")) return "trading";
  if (normalized.endsWith("可供户")) return "available";
  return null;
}

function addRangeProfit(
  positions: LedgerPositionRow[],
  ledgers: BondLedgerSource[],
): LedgerPositionDetail[] {
  const profits = new Map<string, number>();
  for (const ledger of ledgers) {
    for (const row of ledger.positions) {
      const key = positionKey(row);
      profits.set(key, (profits.get(key) ?? 0) + row.dailyProfit);
    }
  }
  return positions.map((position) => ({
    ...position,
    rangeProfit: profits.get(positionKey(position)) ?? 0,
  }));
}

function uniqueTransactionCount(transactions: LedgerTransaction[]): number {
  return new Set(
    transactions.map((transaction) => transaction.code || transaction.name),
  ).size;
}

function positionKey(position: LedgerPositionRow): string {
  return position.code || position.name;
}

function difference(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  return current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined
    ? null
    : current - previous;
}

function annualizeCumulativeProfit(
  cumulativeProfit: number,
  timeWeightedPrincipal: number,
  dayCount: number,
): number | null {
  if (timeWeightedPrincipal <= 0 || dayCount <= 0) return null;
  const value =
    (cumulativeProfit / timeWeightedPrincipal) * (365 / dayCount);
  return Number.isFinite(value) ? value : null;
}

function deannualizeCumulativeReturn(
  annualizedReturn: number | null,
  timeWeightedPrincipal: number,
  dayCount: number,
): number | null {
  if (
    annualizedReturn === null ||
    timeWeightedPrincipal <= 0 ||
    dayCount <= 0
  ) {
    return null;
  }
  const value = annualizedReturn * timeWeightedPrincipal * (dayCount / 365);
  return Number.isFinite(value) ? value : null;
}

function approximatelyEqual(
  left: number | null,
  right: number | null,
  tolerance = 1e-9,
): boolean {
  return (
    left !== null &&
    right !== null &&
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance
  );
}

function addDays(value: string, days: number): string {
  return new Date(parseIsoDate(value).valueOf() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (parseIsoDate(end).valueOf() - parseIsoDate(start).valueOf()) / DAY_MS,
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sampleStandardDeviation(values: number[], mean: number): number {
  return Math.sqrt(
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
      (values.length - 1),
  );
}
