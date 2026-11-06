import type { FinancingModelSnapshot } from "../lib/financing-model";
import type { ShapGroup } from "../lib/issuance-presentation";
import {
  axisLabel,
  colors,
  escapeHtml,
  gridLine,
  tooltip,
} from "./common";
import { setChart, setEmpty } from "./charting";

const forecastAxisLabel = {
  ...axisLabel,
  fontWeight: "normal" as const,
};

const chartBlue = "#2f6fd6";
const chartTeal = "#138a7a";
const chartAmber = "#c87912";
const chartRed = "#c53a32";

export function renderFinancingForecast(
  host: HTMLElement,
  rows: FinancingModelSnapshot["forecast_window"],
): void {
  if (!rows.length) {
    setEmpty(host, "未来窗口预测暂缺");
    return;
  }
  setChart(host, {
    animationDuration: 180,
    aria: {
      enabled: true,
      description:
        "未来发行窗口预测图",
    },
    color: [chartBlue, chartTeal],
    legend: {
      top: 0,
      right: 0,
      itemWidth: 16,
      itemHeight: 10,
      textStyle: forecastAxisLabel,
      data: ["预测偏离", "相对窗口中位数"],
    },
    grid: { left: 12, right: 16, top: 38, bottom: 6, containLabel: true },
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const item = (params as Array<{ dataIndex: number }>)[0];
        const row = rows[item?.dataIndex ?? -1];
        if (!row) return "";
        return [
          `<strong>${escapeHtml(row.date)} ${escapeHtml(row.weekday)}</strong>`,
          `预测偏离 ${signed(row.pred_bp, 2)} bp`,
          `历史分位 P${row.percentile.toFixed(1)}`,
          `窗口变化 ${signed(row.savings_bp_vs_window_median, 2)} bp`,
          `年化金额 ${signed(row["savings_万元/年"], 1)} 万元`,
          `建议 ${escapeHtml(row.label)}`,
        ].join("<br>");
      },
    },
    xAxis: {
      type: "category",
      data: rows.map((row) => row.date),
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: {
        ...forecastAxisLabel,
        interval: 0,
        formatter: (value: string) => value.slice(5).replace("-", "/"),
      },
    },
    yAxis: {
      type: "value",
      name: "bp",
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: forecastAxisLabel,
      nameTextStyle: { ...forecastAxisLabel, align: "left" },
      splitLine: { lineStyle: gridLine },
    },
    series: [
      {
        name: "相对窗口中位数",
        type: "bar",
        barMaxWidth: 28,
        data: rows.map((row) => ({
          value: row.savings_bp_vs_window_median,
          itemStyle: {
            color: row.savings_bp_vs_window_median <= 0 ? chartTeal : chartRed,
            borderRadius:
              row.savings_bp_vs_window_median <= 0 ? [0, 0, 3, 3] : [3, 3, 0, 0],
          },
        })),
      },
      {
        name: "预测偏离",
        type: "line",
        data: rows.map((row) => row.pred_bp),
        symbol: "circle",
        symbolSize: 7,
        smooth: 0.12,
        lineStyle: { color: chartBlue, width: 2.2 },
        itemStyle: {
          color: colors.paper,
          borderColor: chartBlue,
          borderWidth: 2,
        },
      },
    ],
  });
}

/** Show the net contribution of each business group without double counting offsets. */
export function renderIssuanceShapRadar(host: HTMLElement, rows: ShapGroup[]): void {
  if (!rows.length || rows.every(row => row.absolute_bp === 0)) {
    setEmpty(host, "因子贡献暂缺");
    return;
  }
  const compact = host.clientWidth < 400;
  const maximum = Math.max(0.1, ...rows.map(row => row.absolute_bp));
  setChart(host, {
    animationDuration: 180,
    aria: { enabled: true, description: "本次票面预测各类因子的净贡献雷达图" },
    color: [chartBlue],
    legend: {
      top: 0, right: 0, itemWidth: 16, itemHeight: 10,
      textStyle: forecastAxisLabel, data: ["净贡献绝对值"],
    },
    tooltip: {
      ...tooltip,
      trigger: "item",
      formatter: () => rows.map(row =>
        `${escapeHtml(row.display_name)} · 净贡献 ${signed(row.net_bp, 3)} bp`,
      ).join("<br>"),
    },
    radar: {
      center: ["50%", "55%"], radius: compact ? "44%" : "68%", startAngle: 90,
      shape: "polygon", splitNumber: 4,
      indicator: rows.map(row => ({ name: row.display_name, min: 0, max: maximum * 1.12 })),
      axisName: { ...forecastAxisLabel, color: colors.ink },
      axisLine: { lineStyle: { color: colors.line } },
      splitLine: { lineStyle: { color: "rgba(128, 148, 177, 0.24)" } },
      splitArea: { show: false },
    },
    series: [{
      type: "radar", symbol: "circle", symbolSize: 6,
      data: [{
        name: "净贡献绝对值", value: rows.map(row => row.absolute_bp),
        lineStyle: { color: chartBlue, width: 2.2 },
        itemStyle: { color: colors.paper, borderColor: chartBlue, borderWidth: 2 },
        areaStyle: { color: "rgba(47,111,214,0.13)" },
      }],
    }],
  });
}

export function renderFinancingDriverContributions(
  host: HTMLElement,
  rows: Array<{ display_name: string; shap: number; value: number | null }>,
  mode: "support" | "coupon" = "support",
  allLabels = false,
): void {
  if (!rows.length) {
    setEmpty(host, "因子贡献暂缺");
    return;
  }
  const contributionOf = (row: { shap: number }) => mode === "coupon" ? row.shap : -row.shap;
  const compact = host.clientWidth < 400;
  const label = mode === "coupon" ? "票面贡献" : "发行贡献";
  const values = rows.map(contributionOf);
  const maxAbs = Math.max(...values.map(Math.abs), 0.1);
  const bound = Math.ceil(maxAbs * 12) / 10;
  setChart(host, {
    animationDuration: 180,
    aria: {
      enabled: true,
      description: "本次预测因子贡献",
    },
    grid: { left: compact ? 8 : 12, right: compact ? 55 : 78, top: 8, bottom: compact ? 55 : 48, containLabel: true },
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const item = (params as Array<{ dataIndex: number }>)[0];
        const row = rows[item?.dataIndex ?? -1];
        if (!row) return "";
        const contribution = contributionOf(row);
        return [
          `<strong>${escapeHtml(row.display_name)}</strong>`,
          `${label} ${signed(contribution, 3)} bp`,
          ...(row.value === null ? [] : [`因子值 ${row.value.toFixed(4)}`]),
        ].join("<br>");
      },
    },
    xAxis: {
      type: "value",
      min: -bound,
      max: bound,
      name: `${label}（bp）`,
      nameLocation: "middle",
      nameGap: 32,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: { ...forecastAxisLabel,
        formatter: (value: number) => compact && value !== 0 && Math.abs(value) < bound - 1e-9 ? "" : String(value),
      },
      nameTextStyle: { ...forecastAxisLabel, color: colors.muted },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => row.display_name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...forecastAxisLabel, color: colors.ink, width: compact ? 140 : 150, overflow: "truncate", ...(allLabels ? { interval: 0 } : {}) },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 22,
        label: {
          show: true,
          position: "right",
          color: colors.ink,
          fontSize: forecastAxisLabel.fontSize,
          formatter: (params: { value: number }) => signed(params.value, 3),
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: colors.zero, width: 1.4 },
          label: { show: false },
          data: [{ xAxis: 0 }],
        },
        data: values.map((value) => ({
          value,
          itemStyle: {
            color: value >= 0 ? chartBlue : chartAmber,
            borderRadius: value >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
          },
        })),
      },
    ],
  });
}

function signed(value: number, digits: number): string {
  const normalized = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(digits)}`;
}
