// Project the browser-normalized market-report contract into visual view objects.

import { median } from "./rows.ts";
import type {
  ComparablePoint,
  InventoryPoint,
  MarginSnapshot,
  MarketMetric,
  OmoPoint,
  PrimaryIssueDetail,
  ReportData,
} from "./types";

export interface ReportDerived {
  omoHistory: OmoPoint[];
  funds: MarketMetric[];
  governmentBonds: MarketMetric[];
  margin: MarginSnapshot;
  primary: PrimaryIssueDetail[];
  comparable: ComparablePoint[];
  inventory: InventoryPoint[];
}

export function deriveReport(data: ReportData): ReportDerived {
  return {
    omoHistory: omoHistoryPoints(data.omo_operations),
    funds: fundMetrics(data.funding_rates),
    governmentBonds: governmentBondMetrics(data.government_bonds),
    margin: data.margin,
    primary: data.primary_issues,
    comparable: comparablePoints(data.secondary_bonds),
    inventory: inventoryPoints(data.inventory_bonds),
  };
}

export function omoHistoryPoints(rows: ReportData["omo_operations"]): OmoPoint[] {
  const totals = new Map<string, number | null>();
  for (const row of rows) {
    const day = row.operation_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const amount = row.amount_yi;
    const previous = totals.has(day) ? totals.get(day)! : 0;
    totals.set(day, previous === null || amount === null ? null : previous + amount);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-10)
    .map(([day, net_amount]) => ({ day, net_amount }));
}

export function fundMetrics(rates: ReportData["funding_rates"]): MarketMetric[] {
  return ["DR001", "DR007", "DIBO001", "DIBO007"].map((label) => {
    const row = rates.find((item) => item.code === label);
    return {
      label,
      value: row?.rate ?? null,
      change: row?.change_bp ?? null,
      unit: "%",
    };
  });
}

export function governmentBondMetrics(
  rows: ReportData["government_bonds"],
): MarketMetric[] {
  const picks: Array<[string, string]> = [
    ["1Y国债", "1Y"],
    ["5Y国债", "5Y"],
    ["10Y国债", "10Y"],
    ["30Y国债", "超长期限"],
  ];
  return picks.map(([label, axis]) => {
    const row = rows.find(
      (item) => item.category === "国债" && item.tenor === axis,
    );
    return {
      label,
      value: row?.yield_rate ?? null,
      change: row?.change_bp ?? null,
      unit: "%",
    };
  });
}

export function marginSnapshot(value: MarginSnapshot): MarginSnapshot {
  return value;
}

export function primaryPoints(rows: PrimaryIssueDetail[]): PrimaryIssueDetail[] {
  return rows;
}

export function comparablePoints(
  rows: ReportData["secondary_bonds"],
): ComparablePoint[] {
  const points = rows.map(({ issuer, bond_name, tenor_years, trade_yield }) => ({
    issuer,
    bond_name,
    tenor_years,
    trade_yield,
  }));
  return filterComparableOutliers(points).sort(
    (left, right) =>
      left.tenor_years - right.tenor_years ||
      left.bond_name.localeCompare(right.bond_name, "zh-CN"),
  );
}

export function inventoryPoints(rows: InventoryPoint[]): InventoryPoint[] {
  return rows
    .map((row) => ({
      ...row,
      bid_yield:
        typeof row.bid_yield === "number" && row.bid_yield > 0
          ? row.bid_yield
          : null,
      ofr_yield:
        typeof row.ofr_yield === "number" && row.ofr_yield > 0
          ? row.ofr_yield
          : null,
    }))
    .sort((left, right) => left.tenor_years - right.tenor_years);
}

function filterComparableOutliers(
  points: ComparablePoint[],
): ComparablePoint[] {
  if (points.length < 8) return points;
  const slopes: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const left = points[index]!;
    for (
      let rightIndex = index + 1;
      rightIndex < points.length;
      rightIndex += 1
    ) {
      const right = points[rightIndex]!;
      if (right.tenor_years !== left.tenor_years) {
        slopes.push(
          (right.trade_yield - left.trade_yield) /
            (right.tenor_years - left.tenor_years),
        );
      }
    }
  }
  if (!slopes.length) return points;
  const slope = median(slopes);
  const intercept = median(
    points.map((point) => point.trade_yield - slope * point.tenor_years),
  );
  const residuals = points.map(
    (point) => point.trade_yield - (intercept + slope * point.tenor_years),
  );
  const residualCenter = median(residuals);
  const residualMad = median(
    residuals.map((residual) => Math.abs(residual - residualCenter)),
  );
  const threshold = Math.max(0.05, 3.5 * 1.4826 * residualMad);
  return points.filter(
    (point, index) =>
      Math.abs(residuals[index]! - residualCenter) <= threshold,
  );
}
