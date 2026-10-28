import { setChart, type ChartOption } from "./charting";
import {
  axisLabel,
  chartTextSize,
  colors,
  fontFamily,
  gridLine,
  tooltip,
} from "./common";
import { formatEconomicIndicatorTooltip } from "../lib/trading-research/economic-indicators";

export const WORKBENCH_CHART_PALETTE = [
  "#2f6fed",
  "#16a394",
  "#6941c6",
  "#f79009",
  "#d92d20",
  "#0ba5ec",
  "#6172f3",
  "#12b76a",
] as const;

export type WorkbenchBarDatum = {
  label: string;
  value: number | null;
  color?: string;
};

export type WorkbenchCurvePoint = {
  tenor: string;
  value: number;
};

export type EconomicIndicatorTrendPoint = {
  date: string;
  value: number;
};

export type LiquidityRateChartSeries = {
  name: string;
  color: string;
  points: readonly EconomicIndicatorTrendPoint[];
};

export type WorkbenchSeriesHistory = {
  dates: readonly string[];
  series: ReadonlyArray<{
    name: string;
    values: readonly number[];
    color?: string;
  }>;
};

function workbenchSeriesColor(
  series: WorkbenchSeriesHistory["series"][number],
  index: number,
): string {
  return (
    series.color ??
    WORKBENCH_CHART_PALETTE[index % WORKBENCH_CHART_PALETTE.length] ??
    WORKBENCH_CHART_PALETTE[0]
  );
}

type WorkbenchHistory = {
  dates: readonly string[];
  series: Array<{ name: string; values: readonly number[] }>;
};

export function workbenchBarChartOption(
  data: readonly WorkbenchBarDatum[],
  description: string,
  unit: string,
  max?: number,
  thresholds: readonly number[] = [],
  showLegend = false,
): ChartOption {
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: [...WORKBENCH_CHART_PALETTE],
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value: unknown) => value == null ? "—" : `${Number(value).toFixed(unit === "家" ? 0 : 1)}${unit}`,
    },
    legend: showLegend ? { top: 0, data: [description], textStyle: axisLabel } : undefined,
    grid: { left: 8, right: 76, top: showLegend ? 44 : 10, bottom: 24, containLabel: true },
    xAxis: {
      type: "value",
      min: data.some(item => item.value != null && item.value < 0) ? undefined : 0,
      max: max == null ? undefined : Math.max(max, ...data.map(item => item.value ?? 0)),
      splitNumber: 3,
      minInterval: unit === "家" ? 1 : undefined,
      name: unit,
      nameGap: 8,
      nameTextStyle: axisLabel,
      axisLabel: {
        ...axisLabel,
        formatter: (value: number) => `${value}`,
        hideOverlap: true,
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: gridLine },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: data.map((item) => item.value == null ? `${item.label} —` : item.label),
      axisLabel: { ...axisLabel, color: colors.ink },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: showLegend ? description : unit === "%" ? "占比" : "数值",
        type: "bar",
        barMaxWidth: 18,
        showBackground: !data.some(item => item.value != null && item.value < 0),
        backgroundStyle: { color: colors.brandSoft, borderRadius: 5 },
        data: data.map((item, index) => ({
          value: item.value,
          itemStyle: {
            color: item.color ?? WORKBENCH_CHART_PALETTE[index % WORKBENCH_CHART_PALETTE.length],
            borderRadius: [0, 5, 5, 0],
          },
        })),
        label: {
          show: true,
          position: "right",
          color: colors.ink,
          fontFamily,
          fontSize: chartTextSize,
          fontWeight: "normal",
          formatter: ({ value }: { value: unknown }) =>
            value == null ? "—" : `${Number(value).toFixed(unit === "家" ? 0 : 1)}${unit}`,
        },
        markLine: thresholds.length
          ? {
              silent: true,
              symbol: "none",
              data: thresholds.map((value) => ({ xAxis: value })),
              label: {
                show: false,
                color: colors.muted,
                fontFamily,
                fontSize: Math.max(chartTextSize - 2, 12),
                formatter: ({ value }: { value: unknown }) => `${value}%`,
              },
              lineStyle: { color: colors.zero, type: "dashed", width: 1 },
            }
          : undefined,
      },
    ],
  };
  return option;
}

export function renderWorkbenchBarChart(
  host: HTMLElement, data: readonly WorkbenchBarDatum[], description: string, unit: string, max?: number, thresholds: readonly number[] = [],
): void {
  setChart(host, workbenchBarChartOption(data, description, unit, max, thresholds));
}

export function renderWorkbenchTrendChart(
  host: HTMLElement,
  history: WorkbenchSeriesHistory,
  description: string,
  unit: string,
): void {
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: history.series.map(workbenchSeriesColor),
    tooltip: {
      ...tooltip,
      trigger: "axis",
      valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}${unit}`,
    },
    legend: {
      top: 0,
      textStyle: {
        color: colors.ink,
        fontFamily,
        fontSize: chartTextSize,
        fontWeight: "normal",
      },
    },
    grid: { left: 18, right: 20, top: 48, bottom: 28, containLabel: true },
    xAxis: {
      type: "category",
      data: [...history.dates],
      boundaryGap: false,
      axisLabel,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      name: unit,
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: gridLine },
    },
    series: history.series.map((series, index) => ({
      name: series.name,
      type: "line",
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2.5 },
      areaStyle: {
        color: `${workbenchSeriesColor(series, index)}14`,
      },
      data: [...series.values],
    })),
  };
  setChart(host, option);
}

export function renderWorkbenchStackedBarChart(
  host: HTMLElement,
  history: WorkbenchSeriesHistory,
  description: string,
  unit: string,
): void {
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: history.series.map(workbenchSeriesColor),
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value: unknown) => `${Number(value).toFixed(1)}${unit}`,
    },
    legend: {
      top: 0,
      textStyle: {
        color: colors.ink,
        fontFamily,
        fontSize: chartTextSize,
        fontWeight: "normal",
      },
    },
    grid: { left: 18, right: 20, top: 48, bottom: 28, containLabel: true },
    xAxis: {
      type: "category",
      data: [...history.dates],
      axisLabel,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: unit,
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: gridLine },
    },
    series: history.series.map((series) => ({
      name: series.name,
      type: "bar",
      stack: "成交金额",
      barMaxWidth: 26,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      data: [...series.values],
    })),
  };
  setChart(host, option);
}

export function renderWorkbenchHistoryChart(
  host: HTMLElement,
  history: WorkbenchHistory,
  description: string,
): void {
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: [...WORKBENCH_CHART_PALETTE],
    tooltip: {
      ...tooltip,
      trigger: "axis",
      valueFormatter: (value: unknown) => `${Number(value).toFixed(4)}%`,
    },
    legend: {
      top: 0,
      textStyle: {
        color: colors.ink,
        fontFamily,
        fontSize: chartTextSize,
        fontWeight: "normal",
      },
    },
    grid: { left: 18, right: 22, top: 48, bottom: 32, containLabel: true },
    xAxis: {
      type: "category",
      data: [...history.dates],
      boundaryGap: false,
      axisLabel,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: "%",
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: gridLine },
    },
    series: history.series.map((series) => ({
      name: series.name,
      type: "line",
      smooth: true,
      showSymbol: false,
      symbolSize: 7,
      lineStyle: { width: 2.5 },
      data: [...series.values],
    })),
  };
  setChart(host, option);
}

export function renderWorkbenchCurveChart(
  host: HTMLElement,
  name: string,
  points: readonly WorkbenchCurvePoint[],
  description: string,
): void {
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: [WORKBENCH_CHART_PALETTE[0]],
    tooltip: {
      ...tooltip,
      trigger: "axis",
      valueFormatter: (value: unknown) => `${Number(value).toFixed(4)}%`,
    },
    grid: { left: 16, right: 20, top: 24, bottom: 28, containLabel: true },
    xAxis: {
      type: "category",
      data: points.map((point) => point.tenor),
      boundaryGap: false,
      axisLabel,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      name: "%",
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: gridLine },
    },
    series: [
      {
        name,
        type: "line",
        smooth: true,
        symbolSize: 7,
        lineStyle: { width: 2.5 },
        areaStyle: { color: "rgba(47, 111, 237, 0.08)" },
        data: points.map((point) => point.value),
      },
    ],
  };
  setChart(host, option);
}

export function renderEconomicIndicatorTrend(
  host: HTMLElement,
  points: readonly EconomicIndicatorTrendPoint[],
  description: string,
  unit: string,
  decimals: number,
  color: string,
): void {
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const crossesZero = minimum < 0 && maximum > 0;
  const option: ChartOption = {
    animationDuration: 220,
    aria: { enabled: true, description },
    color: [color],
    tooltip: {
      ...tooltip,
      trigger: "axis",
      formatter: (params: unknown) =>
        formatEconomicIndicatorTooltip(params, unit, decimals),
    },
    grid: { left: 2, right: 2, top: 8, bottom: 2 },
    xAxis: {
      type: "category",
      data: points.map((point) => point.date),
      boundaryGap: false,
      show: false,
    },
    yAxis: {
      type: "value",
      scale: true,
      show: false,
    },
    series: [
      {
        name: description,
        type: "line",
        smooth: 0.3,
        showSymbol: false,
        lineStyle: { width: 2.25, cap: "round" },
        areaStyle: { color: `${color}18` },
        data: values,
        markLine: crossesZero
          ? {
              silent: true,
              symbol: "none",
              data: [{ yAxis: 0 }],
              label: { show: false },
              lineStyle: { color: colors.zero, type: "dashed", width: 1 },
            }
          : undefined,
      },
    ],
  };
  setChart(host, option);
}

export function renderLiquidityRateChart(
  host: HTMLElement,
  series: readonly LiquidityRateChartSeries[],
  description: string,
  unit: "%" | "bp",
  decimals = 2,
  showLegend = true,
): void {
  const values = series.flatMap((item) =>
    item.points.map((point) => point.value),
  );
  const crossesZero =
    values.length > 0 && Math.min(...values) < 0 && Math.max(...values) > 0;
  const option: ChartOption = {
    animationDuration: 240,
    aria: { enabled: true, description },
    color: series.map((item) => item.color),
    tooltip: {
      ...tooltip,
      trigger: "axis",
      formatter: (params: unknown) =>
        formatLiquidityRateTooltip(params, unit, decimals),
    },
    legend: showLegend
      ? {
          top: 0,
          type: "scroll",
          textStyle: {
            color: colors.ink,
            fontFamily,
            fontSize: chartTextSize,
          },
        }
      : undefined,
    grid: {
      left: 18,
      right: 20,
      top: showLegend ? 42 : 28,
      bottom: 24,
      containLabel: true,
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLabel: {
        ...axisLabel,
        hideOverlap: true,
        formatter: (value: number) => {
          const date = new Date(value);
          return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
        },
      },
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: unit === "%",
      splitNumber: host.clientHeight < 250 ? 3 : 5,
      name: unit,
      nameTextStyle: axisLabel,
      axisLabel: {
        ...axisLabel,
        formatter: (value: number) => value.toFixed(unit === "bp" ? 0 : 2),
        hideOverlap: true,
      },
      splitLine: { lineStyle: gridLine },
    },
    series: series.map((item) => ({
      name: item.name,
      type: "line",
      smooth: 0.18,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { width: 2 },
      emphasis: { focus: "series" },
      data: item.points.map((point) => [point.date, point.value]),
      markLine:
        unit === "bp" && crossesZero
          ? {
              silent: true,
              symbol: "none",
              data: [{ yAxis: 0 }],
              label: { show: false },
              lineStyle: { color: colors.zero, type: "dashed", width: 1 },
            }
          : undefined,
    })),
  };
  setChart(host, option);
}

function formatLiquidityRateTooltip(
  params: unknown,
  unit: string,
  decimals: number,
): string {
  if (!Array.isArray(params) || params.length === 0) return "";
  const first = params[0] as { axisValueLabel?: unknown };
  const rows = params.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      marker?: unknown;
      seriesName?: unknown;
      value?: unknown;
      data?: unknown;
    };
    const raw = Array.isArray(item.data)
      ? item.data[1]
      : Array.isArray(item.value)
        ? item.value[1]
        : item.data ?? item.value;
    const value = Number(raw);
    if (!Number.isFinite(value)) return [];
    return [
      `<div>${String(item.marker ?? "")}${escapeChartText(item.seriesName)}：${value.toFixed(decimals)} ${unit}</div>`,
    ];
  });
  return `<div>${escapeChartText(first.axisValueLabel)}</div>${rows.join("")}`;
}

function escapeChartText(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
