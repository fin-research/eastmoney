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
const chartSlate = "#a9b8cd";

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

export function renderFinancingGauge(
  host: HTMLElement,
  prediction: FinancingModelSnapshot["prediction"],
): void {
  setChart(host, {
    animationDuration: 180,
    aria: {
      enabled: true,
      description: `发行利差偏离 P${prediction.historical_percentile.toFixed(0)}，窗口${prediction.window_zone}区间`,
    },
    tooltip: {
      ...tooltip,
      formatter: [
        `<strong>历史 P${prediction.historical_percentile.toFixed(0)}</strong>`,
        `预测偏离 ${signed(prediction.deviation_bp, 2)} bp`,
        `窗口 ${prediction.window_zone}`,
      ].join("<br>"),
    },
    series: [
      {
        type: "gauge",
        min: 0,
        max: 100,
        startAngle: 205,
        endAngle: -25,
        radius: "96%",
        center: ["50%", "57%"],
        progress: { show: false },
        axisLine: {
          lineStyle: {
            width: 12,
            color: [
              [1 / 3, "#74bdb3"],
              [2 / 3, "#edc27a"],
              [1, "#de8a84"],
            ],
          },
        },
        pointer: {
          length: "62%",
          width: 4,
          itemStyle: { color: colors.ink },
        },
        anchor: {
          show: true,
          size: 9,
          itemStyle: { color: colors.paper, borderColor: colors.ink, borderWidth: 3 },
        },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          ...forecastAxisLabel,
          distance: 24,
          formatter: (value: number) =>
            value === 0 || value === 25 || value === 50 || value === 100
              ? `${value}`
              : "",
        },
        title: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "62%"],
          color: colors.ink,
          fontSize: 24,
          fontWeight: "bolder",
          formatter: (value: number) => `P${value.toFixed(0)}`,
        },
        data: [{ value: prediction.historical_percentile }],
      },
    ],
  });
}

export function renderFinancingDriverRadar(
  host: HTMLElement,
  rows: FinancingModelSnapshot["driver_structure"],
): void {
  if (!rows.length) {
    setEmpty(host, "驱动结构暂缺");
    return;
  }
  const scale = financingDriverRadarScale(rows);
  setChart(host, {
    animationDuration: 180,
    aria: {
      enabled: true,
      description: "融资择时六维驱动结构雷达图",
    },
    color: [chartBlue, colors.zero],
    legend: {
      top: 0,
      right: 0,
      itemWidth: 16,
      itemHeight: 10,
      textStyle: forecastAxisLabel,
      data: ["发行支持度", "中性基准"],
    },
    tooltip: {
      ...tooltip,
      trigger: "item",
      formatter: (params: unknown) => {
        const name = (params as { name?: string }).name;
        if (name === "中性基准") return "中性基准 50";
        return rows
          .map(
            (row) =>
              `${escapeHtml(row.display_name)} ${row.support_score.toFixed(1)} · ` +
              `${signed(row.support_bp, 3)} bp · 权重 ${(row.importance_weight * 100).toFixed(1)}%`,
          )
          .join("<br>");
      },
    },
    radar: {
      center: ["50%", "55%"],
      radius: "70%",
      startAngle: 90,
      shape: "polygon",
      splitNumber: 4,
      indicator: rows.map((row) => ({
        name: row.display_name,
        min: scale.min,
        max: scale.max,
      })),
      axisName: { ...forecastAxisLabel, color: colors.ink },
      axisLine: { lineStyle: { color: colors.line } },
      splitLine: { lineStyle: { color: "rgba(128, 148, 177, 0.24)" } },
      splitArea: { show: false },
    },
    series: [
      {
        type: "radar",
        symbol: "circle",
        symbolSize: 6,
        data: [
          {
            name: "发行支持度",
            value: rows.map((row) => row.support_score),
            lineStyle: { color: chartBlue, width: 2.2 },
            itemStyle: { color: colors.paper, borderColor: chartBlue, borderWidth: 2 },
            areaStyle: { color: "rgba(47,111,214,0.13)" },
          },
          {
            name: "中性基准",
            value: rows.map(() => 50),
            symbol: "none",
            lineStyle: { color: colors.zero, width: 1.2, type: "dashed" },
            areaStyle: { color: "rgba(255,255,255,0)" },
          },
        ],
      },
    ],
  });
}

export function financingDriverRadarScale(
  rows: FinancingModelSnapshot["driver_structure"],
): { min: number; max: number } {
  const maxDeviation = Math.max(
    ...rows.map((row) => Math.abs(row.support_score - 50)),
    0,
  );
  const halfSpan = Math.min(
    50,
    Math.max(10, Math.ceil((maxDeviation + 2) / 5) * 5),
  );
  return { min: 50 - halfSpan, max: 50 + halfSpan };
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
      axisLabel: { ...forecastAxisLabel, color: colors.ink, width: compact ? 140 : 150, overflow: "truncate" },
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

export function renderFinancingProductComparison(
  host: HTMLElement,
  recommendation: FinancingModelSnapshot["product_recommendation"],
): void {
  const rows = recommendation?.scenarios ?? [];
  if (!rows.length) {
    setEmpty(host, "品种预测暂缺");
    return;
  }
  const displayRows = [...rows].sort((left, right) => left.rank - right.rank);
  setChart(host, {
    animationDuration: 180,
    aria: {
      enabled: true,
      description: `发行方案预测偏离，推荐${recommendation?.recommended_product ?? "—"}`,
    },
    grid: { left: 12, right: 130, top: 8, bottom: 26, containLabel: true },
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const item = (params as Array<{ dataIndex: number }>)[0];
        const row = displayRows[item?.dataIndex ?? -1];
        if (!row) return "";
        return [
          `<strong>${escapeHtml(row.display_name)}</strong>`,
          `相对同类债中位数 ${signed(row.pred_bp, 2)} bp`,
          `同类债中位数 ${row.peer_spread_median_bp.toFixed(2)} bp`,
          `历史 P${row.historical_percentile.toFixed(0)}`,
          `相对最优 +${row.cost_vs_best_bp.toFixed(2)} bp`,
          `建议 ${escapeHtml(row.recommendation_label)}`,
        ].join("<br>");
      },
    },
    xAxis: {
      type: "value",
      name: "相对同类债中位数 bp",
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: forecastAxisLabel,
      nameTextStyle: forecastAxisLabel,
      splitLine: { lineStyle: gridLine },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: displayRows.map((row) => row.display_name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...forecastAxisLabel, color: colors.ink },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 28,
        label: {
          show: true,
          position: "right",
          color: colors.ink,
          fontSize: forecastAxisLabel.fontSize,
          formatter: (params: { dataIndex: number; value: number }) => {
            const row = displayRows[params.dataIndex];
            return `${signed(params.value, 2)} bp · P${row?.historical_percentile.toFixed(0) ?? "—"}`;
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: colors.zero, width: 1.4 },
          label: { show: false },
          data: [{ xAxis: 0 }],
        },
        data: displayRows.map((row) => ({
          value: row.pred_bp,
          itemStyle: {
            color: row.is_recommended ? chartBlue : chartSlate,
            borderRadius: row.pred_bp >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
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
