import { z } from "zod";

export type EconomicIndicatorDefinition = {
  key: string;
  name: string;
  code: string;
  unit: string;
  decimals: number;
  frequency: "日频" | "月频" | "季频" | "不定期";
  factor?: number;
  offset?: number;
  incrementalLookbackDays?: number;
};

export type EconomicIndicatorPoint = {
  date: string;
  value: number;
};

export type EconomicIndicatorSeries = EconomicIndicatorDefinition & {
  points: EconomicIndicatorPoint[];
};

export type EconomicIndicatorGroup = {
  type: string;
  accent: string;
  indicators: EconomicIndicatorDefinition[];
};

export type EconomicIndicatorSeriesGroup = Omit<
  EconomicIndicatorGroup,
  "indicators"
> & {
  indicators: EconomicIndicatorSeries[];
};

export type EconomicIndicatorSnapshot = {
  syncedAt: string;
  groups: EconomicIndicatorSeriesGroup[];
  liquidityRates: EconomicIndicatorSeries[];
};

export const ECONOMIC_INDICATOR_GROUPS: EconomicIndicatorGroup[] = [
  {
    type: "增长与景气",
    accent: "#2f6fed",
    indicators: [
      indicator("gdp-real-yoy", "GDP不变价同比", "EMM00000012", "%", 1, "季频"),
      indicator("manufacturing-pmi", "制造业PMI", "EMM00121996", "%", 1, "月频"),
      indicator("industrial-output-yoy", "工业增加值同比", "EMM00008445", "%", 1, "月频"),
      indicator("industrial-profit-yoy", "工业企业利润总额同比", "EMM00641328", "%", 1, "月频"),
    ],
  },
  {
    type: "需求",
    accent: "#0e9384",
    indicators: [
      indicator("retail-sales-yoy", "社零同比", "EMI00135328", "%", 1, "月频"),
      indicator("fixed-asset-investment-yoy", "固定资产投资同比", "EMM00590832", "%", 1, "月频"),
      indicator("property-investment-yoy", "房地产开发投资同比", "EMI00120220", "%", 1, "月频"),
      indicator("exports-yoy", "出口金额同比", "EMM00053058", "%", 1, "月频"),
    ],
  },
  {
    type: "价格",
    accent: "#7f56d9",
    indicators: [
      indicator("china-cpi-yoy", "CPI同比", "EMM00072301", "%", 1, "月频"),
      indicator("china-core-cpi-yoy", "核心CPI同比", "EMI01737210", "%", 1, "月频", 1, -100),
      indicator("china-ppi-yoy", "PPI同比", "EMM00073348", "%", 1, "月频"),
      indicator("gdp-deflator-yoy", "GDP平减指数同比", "EMM01607812", "%", 1, "季频"),
    ],
  },
  {
    type: "货币与信用",
    accent: "#dc6803",
    indicators: [
      indicator("m1-yoy", "M1同比", "EMM00087084", "%", 1, "月频"),
      indicator("m2-yoy", "M2同比", "EMM00087086", "%", 1, "月频"),
      indicator("tsf-stock-yoy", "社融存量同比", "EMM00634721", "%", 1, "月频"),
      indicator("rmb-loans-yoy", "人民币贷款同比", "EMM00087129", "%", 1, "月频"),
    ],
  },
  {
    type: "高频指标",
    accent: "#079455",
    indicators: [
      indicator("home-sales-30-city", "30城商品房成交", "EMI01778636", "万平方米", 1, "日频"),
      indicator("nanhua-industrials", "南华工业品指数", "EMI00227697", "点", 1, "日频"),
      indicator("rebar-spot", "螺纹钢现货", "EMI01733174", "元/吨", 0, "日频"),
      indicator("cement-price-index", "水泥价格指数", "EMI01670402", "点", 1, "日频"),
    ],
  },
  {
    type: "海外基本面",
    accent: "#1570ef",
    indicators: [
      indicator("us-cpi-yoy", "美国CPI同比", "EMG00000733", "%", 1, "月频"),
      indicator("us-core-pce-yoy", "核心PCE同比", "EMG00157776", "%", 1, "月频"),
      indicator("us-nonfarm-payroll", "新增非农就业", "EMG00152118", "千人", 0, "月频"),
      indicator("us-unemployment", "失业率", "EMG00001039", "%", 1, "月频"),
    ],
  },
  {
    type: "海外利率",
    accent: "#c4320a",
    indicators: [
      indicator("fed-funds-target", "联邦基金目标利率", "EMG00146415", "%", 2, "不定期"),
      indicator("ust-2y", "美债2Y", "EMG00001306", "%", 2, "日频"),
      indicator("ust-10y", "美债10Y", "EMG00001310", "%", 2, "日频"),
      indicator("ust-10y-2y", "10Y-2Y期限利差", "EMG01339436", "bp", 0, "日频", 100),
    ],
  },
  {
    type: "汇率与商品",
    accent: "#b54708",
    indicators: [
      indicator("dxy", "美元指数 DXY", "EMG00001435", "点", 2, "日频"),
      indicator("usd-cnh", "USD/CNH", "EMM00618963", "", 4, "日频"),
      indicator("wti", "WTI原油", "EMI00531920", "美元/桶", 2, "日频"),
      indicator("gold", "黄金", "EMI00224675", "美元/盎司", 1, "日频"),
    ],
  },
  {
    type: "全球风险资产",
    accent: "#6938ef",
    indicators: [
      indicator("sp-500", "标普500", "EMG00002593", "点", 1, "日频"),
      indicator("nasdaq", "纳斯达克", "EMG00002594", "点", 1, "日频"),
      indicator("msci-em", "MSCI新兴市场指数", "EMG01582711", "点", 1, "日频"),
      indicator("vix", "VIX", "EMG00002651", "点", 2, "日频"),
    ],
  },
];

export const LIQUIDITY_RATE_INDICATORS: EconomicIndicatorDefinition[] = [
  indicator("reverse-repo-7d", "7D逆回购利率", "E1715081", "%", 2, "日频"),
  indicator("dr001", "DR001", "E1300003", "%", 4, "日频"),
  indicator("dr007", "DR007", "E1300004", "%", 4, "日频"),
  indicator("r007", "R007", "E1704420", "%", 4, "日频"),
  indicator("ncd-aaa-1y", "1Y AAA NCD", "E1713049", "%", 3, "日频"),
  indicator("cgb-1y", "1Y国债", "E1000172", "%", 4, "日频"),
  indicator("cgb-10y", "10Y国债", "E1000180", "%", 4, "日频"),
  indicator("cgb-30y", "30Y国债", "E1000183", "%", 4, "日频"),
];

export const LIABILITY_REPORT_RATE_INDICATORS: EconomicIndicatorDefinition[] = [
  liabilityRateIndicator("broker-aaa-minus-1y", "中债证券公司债AAA- 1Y", "E1707781"),
  liabilityRateIndicator("broker-aaa-minus-2y", "中债证券公司债AAA- 2Y", "E1707782"),
  liabilityRateIndicator("broker-aaa-minus-3y", "中债证券公司债AAA- 3Y", "E1707783"),
  liabilityRateIndicator("broker-aaa-minus-5y", "中债证券公司债AAA- 5Y", "E1707785"),
  liabilityRateIndicator("cgb-1y-liability", "中债国债1Y", "E1000172"),
  liabilityRateIndicator("cgb-3y-liability", "中债国债3Y", "E1000174"),
  liabilityRateIndicator("cgb-5y-liability", "中债国债5Y", "E1000176"),
  liabilityRateIndicator("state-bank-ncd-3m", "国有行同业存单3M", "E1704281"),
  liabilityRateIndicator("state-bank-ncd-6m", "国有行同业存单6M", "E1704282"),
  liabilityRateIndicator("state-bank-ncd-9m", "国有行同业存单9M", "E1704283"),
  liabilityRateIndicator("state-bank-ncd-1y", "国有行同业存单1Y", "E1704284"),
];

export const DASHBOARD_ECONOMIC_INDICATORS = uniqueIndicatorDefinitions([
  ...ECONOMIC_INDICATOR_GROUPS.flatMap((group) => group.indicators),
  ...LIQUIDITY_RATE_INDICATORS,
]);

export const ALL_ECONOMIC_INDICATORS = uniqueIndicatorDefinitions([
  ...DASHBOARD_ECONOMIC_INDICATORS,
  ...LIABILITY_REPORT_RATE_INDICATORS,
  indicator('shibor-3m', 'SHIBOR 3M', 'E1300079', '%', 4, '日频'),
  indicator('shibor-1w', 'SHIBOR 1W', 'DM_SHIBOR_1W', '%', 4, '日频'),
  indicator('shibor-on', 'SHIBOR O/N', 'DM_SHIBOR_ON', '%', 4, '日频'),
  indicator('cdb-3y', '国开债3Y', 'E1701708', '%', 4, '日频'),
  indicator('cdb-10y', '国开债10Y', 'E1701714', '%', 4, '日频'),
  indicator('corporate-aaa-3y', 'AAA企业债3Y', 'E1000413', '%', 4, '日频'),
]);

const rowSchema = z.object({
  code: z.string(),
  date: z.string(),
  value: z.union([z.number(), z.string()]),
});

const responseSchema = z.object({
  asOf: z.string(),
  syncedAt: z.string(),
  rows: z.array(rowSchema),
});

const MAX_CHART_POINTS = 96;
const MAX_LIQUIDITY_CHART_POINTS = 420;

function indicator(
  key: string,
  name: string,
  code: string,
  unit: string,
  decimals: number,
  frequency: EconomicIndicatorDefinition["frequency"],
  factor?: number,
  offset?: number,
): EconomicIndicatorDefinition {
  return { key, name, code, unit, decimals, frequency, factor, offset };
}

function uniqueIndicatorDefinitions(
  definitions: EconomicIndicatorDefinition[],
): EconomicIndicatorDefinition[] {
  return [...new Map(definitions.map((definition) => [definition.code, definition])).values()];
}

function liabilityRateIndicator(
  key: string,
  name: string,
  code: string,
): EconomicIndicatorDefinition {
  return { ...indicator(key, name, code, "%", 4, "日频"), incrementalLookbackDays: 400 };
}

export function economicIndicatorRange(now = new Date()): {
  startDate: string;
  endDate: string;
} {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 18, 1),
  );
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

export function emptyEconomicIndicatorGroups(): EconomicIndicatorSeriesGroup[] {
  return ECONOMIC_INDICATOR_GROUPS.map((group) => ({
    ...group,
    indicators: group.indicators.map((definition) => ({
      ...definition,
      points: [],
    })),
  }));
}

export function emptyLiquidityRateSeries(): EconomicIndicatorSeries[] {
  return LIQUIDITY_RATE_INDICATORS.map((definition) => ({
    ...definition,
    points: [],
  }));
}

export function mapEconomicIndicatorRows(
  rows: Array<z.infer<typeof rowSchema>>,
): EconomicIndicatorSeriesGroup[] {
  const rowsByCode = new Map<string, EconomicIndicatorPoint[]>();

  for (const row of rows) {
    const rawValue = typeof row.value === "number" ? row.value : Number(row.value);
    if (!Number.isFinite(rawValue)) continue;
    const points = rowsByCode.get(row.code) ?? [];
    points.push({ date: row.date, value: rawValue });
    rowsByCode.set(row.code, points);
  }

  return ECONOMIC_INDICATOR_GROUPS.map((group) => ({
    ...group,
    indicators: group.indicators.map((definition) => {
      const points = (rowsByCode.get(definition.code) ?? [])
        .slice()
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((point) => ({
          date: point.date,
          value:
            point.value * (definition.factor ?? 1) + (definition.offset ?? 0),
        }));
      return { ...definition, points: downsample(points) };
    }),
  }));
}

export function mapLiquidityRateRows(
  rows: Array<z.infer<typeof rowSchema>>,
): EconomicIndicatorSeries[] {
  const rowsByCode = rowsByIndicatorCode(rows);
  return LIQUIDITY_RATE_INDICATORS.map((definition) => ({
    ...definition,
    points: (rowsByCode.get(definition.code) ?? [])
      .slice()
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-MAX_LIQUIDITY_CHART_POINTS)
      .map((point) => ({
        date: point.date,
        value: point.value * (definition.factor ?? 1) + (definition.offset ?? 0),
      })),
  }));
}

export async function fetchEconomicIndicatorSnapshot(
  signal?: AbortSignal,
): Promise<EconomicIndicatorSnapshot> {
  const response = await fetch("/api/economic-indicators", {
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`经济指标请求失败（HTTP ${response.status}）`);
  }
  const payload = responseSchema.parse(await response.json());
  return {
    syncedAt: payload.syncedAt,
    groups: mapEconomicIndicatorRows(payload.rows),
    liquidityRates: mapLiquidityRateRows(payload.rows),
  };
}

export function formatEconomicDataRefresh(syncedAt: string): string {
  const value = new Date(syncedAt);
  if (Number.isNaN(value.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function economicIndicatorChange(
  points: readonly EconomicIndicatorPoint[],
): number | null {
  if (points.length < 2) return null;
  return points.at(-1)!.value - points.at(-2)!.value;
}

export function formatEconomicIndicatorChange(
  change: number | null,
  decimals: number,
): string {
  if (change === null || !Number.isFinite(change)) return "—";
  const normalized = Math.abs(change) < 10 ** (-decimals) / 2 ? 0 : change;
  const formatted = Math.abs(normalized).toLocaleString("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (normalized > 0) return `+${formatted}`;
  if (normalized < 0) return `-${formatted}`;
  return formatted;
}

export function formatEconomicIndicatorTooltip(
  params: unknown,
  unit: string,
  decimals: number,
): string {
  const first = Array.isArray(params) ? params[0] : params;
  if (!first || typeof first !== "object") return "";
  const item = first as {
    axisValue?: unknown;
    axisValueLabel?: unknown;
    data?: unknown;
    value?: unknown;
  };
  const date = item.axisValueLabel ?? item.axisValue ?? "";
  const rawValue = item.data ?? item.value;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return escapeTooltipHtml(date);
  const formatted = value.toLocaleString("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `<div>${escapeTooltipHtml(date)}</div><div>${escapeTooltipHtml(formatted)}${unit ? ` ${escapeTooltipHtml(unit)}` : ""}</div>`;
}

function downsample(points: EconomicIndicatorPoint[]): EconomicIndicatorPoint[] {
  if (points.length <= MAX_CHART_POINTS) return points;
  const lastIndex = points.length - 1;
  const selected = Array.from({ length: MAX_CHART_POINTS }, (_, index) =>
    Math.round((index * lastIndex) / (MAX_CHART_POINTS - 1)),
  );
  return [...new Set(selected)].map((index) => points[index]!);
}

function rowsByIndicatorCode(
  rows: Array<z.infer<typeof rowSchema>>,
): Map<string, EconomicIndicatorPoint[]> {
  const rowsByCode = new Map<string, EconomicIndicatorPoint[]>();
  for (const row of rows) {
    const rawValue = typeof row.value === "number" ? row.value : Number(row.value);
    if (!Number.isFinite(rawValue)) continue;
    const points = rowsByCode.get(row.code) ?? [];
    points.push({ date: row.date, value: rawValue });
    rowsByCode.set(row.code, points);
  }
  return rowsByCode;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function escapeTooltipHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
