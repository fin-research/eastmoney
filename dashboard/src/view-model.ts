import {
  compact,
  formatOmoNetAmount,
  integer,
  number,
  signed,
  tone,
} from "./formatters.ts";
import type { ReportDerived } from "./report-view";
import type {
  ComparablePoint,
  InventoryPoint,
  MarketReportResource,
  MarginSnapshot,
  OmoPoint,
  PrimaryIssueDetail,
  PrimarySummary,
  ReportData,
} from "./types";
import {
  formatPrimaryAmount,
  formatPrimaryCoupons,
  PRIMARY_CATEGORY_ORDER,
} from "./primary-issues.ts";

export type MetricIconName =
  | "bank"
  | "liquidity"
  | "bond"
  | "equity"
  | "issuance"
  | "trade"
  | "leverage"
  | "profit";
export type StatIconName = "turnover" | "margin";
export type SummaryTone = "up" | "down" | "inject" | "withdraw" | "flat";

export interface MetricCardView {
  label: string;
  value?: string;
  detail?: string;
  lines?: string[];
  valueTone: string;
  icon: MetricIconName;
}

export interface StatCardView {
  label: string;
  value: string;
  change: string;
  valueTone: string;
  icon: StatIconName;
}

export interface SummaryItemView {
  label: string;
  value: string;
  tone: SummaryTone;
}

export interface TableRowView {
  values: string[];
  title?: string;
  tagIndex?: number;
}

export function coreMetricCards(
  data: ReportData,
  derived: ReportDerived,
  missingResources: readonly MarketReportResource[] = [],
): MetricCardView[] {
  const missing = new Set(missingResources);
  const omoPoint = derived.omoHistory.find((point) => point.day === data.report_date);
  const omo = omoPoint ? omoPoint.net_amount : 0;
  const dr007 = derived.funds.find((item) => item.label === "DR007");
  const government10 = derived.governmentBonds.find(
    (item) => item.label === "10Y国债",
  );
  const shanghai = data.equities.find((item) => item.name === "上证指数");
  const tradePoints = [...derived.inventory]
    .filter((point) => Number.isFinite(point.trade_yield))
    .sort((left, right) => right.tenor_years - left.tenor_years);
  const tradeCard: MetricCardView = {
    label: "债券成交",
    value: missing.has("todayTrades") || missing.has("favoriteQuotes")
      ? "—"
      : tradePoints.length ? `${tradePoints.length} 只` : "—",
    detail: missing.has("todayTrades") || missing.has("favoriteQuotes")
      ? "数据缺失"
      : tradePoints.length ? "当日成交" : "今日暂无",
    valueTone: "flat",
    icon: "trade",
  };

  return [
    {
      label: "公开市场操作",
      value: missing.has("omo") || omo === null
        ? "—"
        : `${Math.abs(omo).toLocaleString("zh-CN")} 亿`,
      detail: missing.has("omo") || omo === null
        ? "数据缺失"
        : omo > 0 ? "净投放" : omo < 0 ? "净回笼" : "净投放为零",
      valueTone: omo === null ? "flat" : omo > 0 ? "inject" : omo < 0 ? "withdraw" : "flat",
      icon: "bank",
    },
    {
      label: "DR007",
      value: dr007 ? `${number(dr007.value, 4)}%` : "—",
      detail: missing.has("fundingDr")
        ? "数据缺失"
        : dr007 ? signed(dr007.change, "bp") : "数据暂缺",
      valueTone: tone(dr007?.change),
      icon: "liquidity",
    },
    {
      label: "10Y 国债",
      value: government10 ? `${number(government10.value, 4)}%` : "—",
      detail: missing.has("governmentBonds")
        ? "数据缺失"
        : government10 ? signed(government10.change, "bp") : "数据暂缺",
      valueTone: tone(government10?.change),
      icon: "bond",
    },
    {
      label: "上证指数",
      value: shanghai ? number(shanghai.close, 2) : "—",
      detail: missing.has("industry")
        ? "数据缺失"
        : shanghai ? signed(shanghai.change_pct, "%") : "数据暂缺",
      valueTone: tone(shanghai?.change_pct),
      icon: "equity",
    },
    {
      label: "同业发行",
      value: missing.has("primary") || data.primary_summary.current_amount === null
        ? "—"
        : `${compactValue(data.primary_summary.current_amount)} 亿`,
      detail: missing.has("primary")
        ? "数据缺失"
        : signed(data.primary_summary.change_amount, " 亿", 0),
      valueTone: tone(data.primary_summary.change_amount),
      icon: "issuance",
    },
    tradeCard,
  ];
}

export function equityStatCards(
  data: ReportData,
  margin: MarginSnapshot,
): StatCardView[] {
  return [
    {
      label: "沪深京成交额",
      value: integer(data.turnover_yi, " 亿元"),
      change: Number.isFinite(data.turnover_change_yi)
        ? signed(data.turnover_change_yi, " 亿元", 0)
        : "较前日变动暂缺",
      valueTone: tone(data.turnover_change_yi),
      icon: "turnover",
    },
    {
      label: "融资融券余额",
      value: integer(margin.total, " 亿元"),
      change: Number.isFinite(margin.total_change)
        ? signed(margin.total_change, " 亿元", 0)
        : "较前日变动暂缺",
      valueTone: tone(margin.total_change),
      icon: "margin",
    },
  ];
}

export function omoSummaryItems(
  points: OmoPoint[],
  reportDate: string,
): SummaryItemView[] {
  const available = [...points]
    .filter(
      (point) =>
        point.day <= reportDate,
    )
    .sort((left, right) => left.day.localeCompare(right.day));
  const sum = (size: number): number | null => {
    const rows = available.slice(-size);
    return rows.length
      ? rows.reduce<number | null>((total, point) => total === null || point.net_amount === null ? null : total + point.net_amount, 0)
      : null;
  };
  return [
    omoSummaryItem("当日净额", available.at(-1)?.net_amount ?? null),
    omoSummaryItem("近 5 日累计", sum(5)),
    omoSummaryItem("近 10 日累计", sum(10)),
  ];
}

export function primarySummaryItems(
  summary: PrimarySummary,
): SummaryItemView[] {
  return [
    {
      label: "当日发行",
      value: `${number(summary.current_amount, 2)} 亿`,
      tone: "flat",
    },
    {
      label: "较上一交易日",
      value: signed(summary.change_amount, " 亿", 2),
      tone: tone(summary.change_amount),
    },
  ];
}

export function comparableSummaryItems(
  points: ComparablePoint[],
): SummaryItemView[] {
  const values = points
    .filter(
      (point) =>
        point.tenor_years <= 5 && Number.isFinite(point.trade_yield),
    )
    .map((point) => point.trade_yield)
    .sort((left, right) => left - right);
  return [
    { label: "有效样本", value: `${values.length} 只`, tone: "flat" },
    {
      label: "收益率区间",
      value: values.length
        ? `${number(values[0], 2)}%–${number(values.at(-1), 2)}%`
        : "—",
      tone: "flat",
    },
  ];
}

export function inventorySummaryItems(
  points: InventoryPoint[],
): SummaryItemView[] {
  const valuations = points
    .map((point) => point.valuation)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const median =
    valuations.length === 0
      ? null
      : valuations.length % 2
        ? valuations[Math.floor(valuations.length / 2)]
        : ((valuations[valuations.length / 2 - 1] ?? 0) +
            (valuations[valuations.length / 2] ?? 0)) /
          2;
  return [
    { label: "存量债", value: `${points.length} 只`, tone: "flat" },
    {
      label: "当日成交",
      value: `${points.filter((point) => Number.isFinite(point.trade_yield)).length} 只`,
      tone: "flat",
    },
    {
      label: "估值中位数",
      value: Number.isFinite(median) ? `${number(median, 4)}%` : "—",
      tone: "flat",
    },
  ];
}

export function primaryRows(points: PrimaryIssueDetail[]): TableRowView[] {
  return points.map((point) => ({
    title: point.bond_names.join("/"),
    tagIndex:
      PRIMARY_CATEGORY_ORDER.indexOf(
        point.category as (typeof PRIMARY_CATEGORY_ORDER)[number],
      ) + 1,
    values: [
      point.category,
      point.issue_date,
      point.issuer,
      point.tenors.join("/"),
      formatPrimaryAmount(point.amount),
      formatPrimaryCoupons(point.coupons),
    ],
  }));
}

export function comparableTenorRows(
  points: ComparablePoint[],
): TableRowView[] {
  const candidates = [...points]
    .filter(
      (point) =>
        Number.isFinite(point.tenor_years) &&
        Number.isFinite(point.trade_yield) &&
        point.tenor_years <= 5,
    )
    .sort(
      (left, right) =>
        left.tenor_years - right.tenor_years ||
        left.bond_name.localeCompare(right.bond_name, "zh-CN"),
    );
  const selected: Array<{ target: number; point: ComparablePoint }> = [];
  const used = new Set<ComparablePoint>();
  for (const target of [1, 2, 3, 5]) {
    const point = candidates
      .filter((candidate) => !used.has(candidate))
      .sort(
        (left, right) =>
          Math.abs(left.tenor_years - target) -
            Math.abs(right.tenor_years - target) ||
          left.tenor_years - right.tenor_years,
      )[0];
    if (!point) continue;
    used.add(point);
    selected.push({ target, point });
  }
  return selected.map(({ target, point }) => ({
    tagIndex: [1, 2, 3, 5].indexOf(target) + 1,
    values: [
      `${target}Y`,
      point.bond_name,
      point.issuer,
      `${number(point.trade_yield, 2)}%`,
    ],
  }));
}

function omoSummaryItem(
  label: string,
  value: number | null,
): SummaryItemView {
  if (!Number.isFinite(value)) return { label, value: "—", tone: "flat" };
  const numeric = value as number;
  return {
    label,
    value: formatOmoNetAmount(numeric),
    tone: numeric > 0 ? "inject" : numeric < 0 ? "withdraw" : "flat",
  };
}

function compactValue(value: number): string {
  return value.toLocaleString("zh-CN", {
    maximumFractionDigits: 3,
  });
}
