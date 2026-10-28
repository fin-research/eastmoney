import { number, shortDate, signed } from "../formatters";
import {
  chooseBestLabelPlacement,
  type LabelRect,
} from "../label-placement";
import type { MarketMetric, OmoPoint } from "../types";
import {
  axisLabel,
  chartTextSize,
  colors,
  escapeHtml,
  fontFamily,
  gridLine,
  rem,
  tooltip,
  zeroLine,
} from "./common";
import { seriesLineSegments, setChart, setEmpty } from "./charting";

export function renderOmo(host: HTMLElement, points: OmoPoint[]): void {
  if (!points.length) {
    setEmpty(host, "公开市场操作数据暂缺");
    return;
  }
  const amounts = points.map((point) => point.net_amount).filter((value): value is number => value !== null);
  if (!amounts.length) {
    setEmpty(host, "公开市场操作金额暂缺");
    return;
  }
  const maximum = Math.max(0, ...amounts);
  const minimum = Math.min(0, ...amounts);
  const span = Math.max(1, maximum - minimum);
  const axisStep = span >= 10_000 ? 1_000 : span >= 5_000 ? 500 : 100;
  const axisMaximum =
    Math.ceil((maximum + span * 0.12) / axisStep) * axisStep;
  const axisMinimum =
    Math.floor((minimum - span * 0.1) / axisStep) * axisStep;

  setChart(host, {
    animationDuration: 280,
    aria: {
      enabled: true,
      description: "近十个操作日公开市场操作量柱状图",
    },
    grid: { left: 0, right: 0, top: 3, bottom: 3, containLabel: true },
    tooltip: {
      ...tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const item = (params as Array<{ dataIndex: number }>)[0];
        const point = item ? points[item.dataIndex] : undefined;
        if (!point) return "";
        if (point.net_amount === null) return `${escapeHtml(point.day)}<br>操作金额暂缺`;
        const direction = point.net_amount >= 0 ? "净投放" : "净回笼";
        return `${escapeHtml(point.day)}<br><strong>${direction} ${Math.abs(point.net_amount).toLocaleString("zh-CN")} 亿元</strong>`;
      },
    },
    xAxis: {
      type: "category",
      data: points.map((point) => shortDate(point.day)),
      axisLine: { onZero: true, lineStyle: zeroLine },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: {
      type: "value",
      min: axisMinimum,
      max: axisMaximum,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
      splitLine: { lineStyle: gridLine },
    },
    series: [
      {
        type: "bar",
        barMaxWidth: 38,
        data: points.map((point, index) => ({
          value: point.net_amount,
          label: {
            position: (point.net_amount ?? 0) >= 0 ? "top" : "bottom",
            align: index === points.length - 1 ? "right" : "center",
            color: colors.ink,
            textBorderColor: colors.paper,
            textBorderWidth: 2,
            distance: 7,
          },
          itemStyle: {
            color: (point.net_amount ?? 0) >= 0 ? colors.green : colors.red,
            borderRadius: (point.net_amount ?? 0) >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2],
          },
        })),
        label: {
          show: true,
          color: colors.ink,
          fontFamily,
          fontSize: chartTextSize,
          fontWeight: 600,
          formatter: ({ value }: { value: number }) => {
            const amount = Math.abs(Math.round(value)).toLocaleString("zh-CN");
            return `${value > 0 ? "+" : value < 0 ? "−" : ""}${amount}`;
          },
        },
        labelLayout: { hideOverlap: false },
      },
    ],
  });
}

export function renderGovernmentCurve(
  host: HTMLElement,
  metrics: MarketMetric[],
): void {
  const valid = metrics.filter((item) => Number.isFinite(item.value));
  if (!valid.length) {
    setEmpty(host, "国债收益率数据暂缺");
    return;
  }
  const current = valid.map((item) => item.value as number);
  const previous = valid.map(
    (item) =>
      (item.value as number) -
      (Number.isFinite(item.change) ? (item.change as number) / 100 : 0),
  );
  const curveSpan = Math.max(...current) - Math.min(...current);
  const maxDailyMove = Math.max(
    ...current.map((value, index) =>
      Math.abs(value - (previous[index] ?? value)),
    ),
  );
  const separationFactor =
    maxDailyMove > 0
      ? Math.max(6, Math.min(18, Math.round((curveSpan * 0.18) / maxDailyMove)))
      : 1;
  const previousVisual = previous.map((value, index) => {
    const today = current[index] ?? value;
    return today + (value - today) * separationFactor;
  });
  const labelFontSize = host.clientWidth < 380 ? rem(0.875) : rem(1);
  const labelLineHeight = labelFontSize * 1.2;
  const labelLayout = createCurveLabelLayout(
    host,
    valid,
    current,
    previousVisual,
  );
  setChart(host, {
    animationDuration: 300,
    aria: { enabled: true, description: "关键期限国债收益率曲线" },
    grid: {
      left: 0,
      right: 0,
      top: 3,
      bottom: 3,
      containLabel: true,
    },
    legend: {
      bottom: rem(2.25),
      right: 6,
      itemWidth: 15,
      itemHeight: 3,
      textStyle: axisLabel,
      data: ["昨日", "今日"],
    },
    tooltip: {
      ...tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const items = params as Array<{
          dataIndex: number;
          seriesName: string;
          value: number;
          data:
            | number
            | { value: number; actual?: number; change?: number | null };
          marker: string;
        }>;
        const metric = valid[items[0]?.dataIndex ?? -1];
        if (!metric) return "";
        return [
          `<strong>${escapeHtml(metric.label)}</strong>`,
          ...items.map((item) => {
            const actual =
              typeof item.data === "object" && "actual" in item.data
                ? item.data.actual
                : item.value;
            const label = item.seriesName.startsWith("昨日")
              ? "昨日"
              : item.seriesName;
            return `${item.marker}${escapeHtml(label)} ${number(actual, 4)}%`;
          }),
          `变动 ${signed(metric.change, "bp")}`,
        ].join("<br>");
      },
    },
    xAxis: {
      type: "category",
      data: valid.map((item) => item.label.replace("国债", "")),
      boundaryGap: true,
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { ...axisLabel, formatter: "{value}%" },
      splitLine: { lineStyle: gridLine },
    },
    series: [
      {
        name: "昨日",
        type: "line",
        data: previousVisual.map((value, index) => ({
          value,
          actual: previous[index] ?? value,
        })),
        symbol: "emptyCircle",
        symbolSize: 9,
        lineStyle: { color: colors.quiet, width: 4, type: "dashed" },
        itemStyle: {
          color: colors.paper,
          borderColor: colors.quiet,
          borderWidth: 2,
        },
      },
      {
        name: "今日",
        type: "line",
        data: current.map((value, index) => ({
          value,
          change: valid[index]?.change,
        })),
        symbolSize: 8,
        lineStyle: { color: colors.brand, width: 2.5 },
        itemStyle: { color: colors.brand },
        label: {
          show: true,
          position: "top",
          color: colors.ink,
          fontFamily,
          fontSize: labelFontSize,
          fontWeight: 700,
          lineHeight: labelLineHeight,
          formatter: ({
            value,
            data,
          }: {
            value: number;
            data: { change?: number | null };
          }) => {
            const change = data.change;
            const changeStyle =
              !Number.isFinite(change) || change === 0
                ? "flat"
                : (change as number) > 0
                  ? "up"
                  : "down";
            const changeText = Number.isFinite(change)
              ? signed(change, "bp")
              : "—";
            return `{value|${number(value, 4)}}\n{${changeStyle}|${changeText}}`;
          },
          rich: {
            value: {
              color: colors.ink,
              fontFamily,
              fontSize: labelFontSize,
              fontWeight: 750,
              lineHeight: labelLineHeight,
            },
            up: {
              color: colors.up,
              fontFamily,
              fontSize: labelFontSize,
              fontWeight: 700,
              lineHeight: labelLineHeight,
            },
            down: {
              color: colors.down,
              fontFamily,
              fontSize: labelFontSize,
              fontWeight: 700,
              lineHeight: labelLineHeight,
            },
            flat: {
              color: colors.muted,
              fontFamily,
              fontSize: labelFontSize,
              fontWeight: 700,
              lineHeight: labelLineHeight,
            },
          },
        },
        labelLayout,
      },
    ],
  });
}

function createCurveLabelLayout(
  host: HTMLElement,
  metrics: MarketMetric[],
  current: number[],
  previous: number[],
): (params: {
  dataIndex?: number;
  rect: LabelRect;
  labelRect: LabelRect;
}) => {
  x: number;
  y: number;
  align: "left";
  verticalAlign: "top";
  hideOverlap: false;
} {
  const placed: LabelRect[] = [];
  const seen = new Set<number>();
  let lineObstacles: ReturnType<typeof curveLineSegments> | null = null;

  function curveLineSegments() {
    const categories = metrics.map((item) => item.label.replace("国债", ""));
    return [
      ...seriesLineSegments(
        host,
        0,
        categories.map(
          (category, index) =>
            [category, previous[index]!] as [string | number, number],
        ),
      ),
      ...seriesLineSegments(
        host,
        1,
        categories.map(
          (category, index) =>
            [category, current[index]!] as [string | number, number],
        ),
      ),
    ];
  }

  return (params) => {
    const index = params.dataIndex ?? 0;
    if (seen.has(index)) {
      seen.clear();
      placed.length = 0;
      lineObstacles = null;
    }
    seen.add(index);
    lineObstacles ??= curveLineSegments();

    const width = host.clientWidth;
    const height = host.clientHeight;
    const point = {
      x: params.rect.x + params.rect.width / 2,
      y: params.rect.y + params.rect.height / 2,
    };
    const label = {
      width: params.labelRect.width,
      height: params.labelRect.height,
    };
    const bounds = {
      x: 8,
      y: 8,
      width: Math.max(0, width - 16),
      height: Math.max(0, height - rem(2.2) - 16),
    };
    const reserved: LabelRect[] = [
      {
        x: Math.max(0, width - rem(8.5)),
        y: Math.max(0, height - rem(4.05)),
        width: rem(8.5),
        height: rem(1.55),
      },
      {
        x: 0,
        y: Math.max(0, height - rem(2.2)),
        width,
        height: rem(2.2),
      },
      {
        x: 0,
        y: 0,
        width: rem(2.5),
        height,
      },
    ];
    const change = metrics[index]?.change;
    const preferred =
      Number.isFinite(change) && change !== 0
        ? (change as number) > 0
          ? ("top" as const)
          : ("bottom" as const)
        : index === 0
          ? ("top" as const)
          : ("bottom" as const);
    const placement = chooseBestLabelPlacement({
      point,
      label,
      bounds,
      obstacles: [...reserved, ...placed],
      preferred,
      gap: rem(0.55),
      collisionPadding: rem(0.3),
      lineObstacles,
      linePadding: rem(0.28),
    });
    placed.push(placement);
    return {
      x: placement.x,
      y: placement.y,
      align: "left",
      verticalAlign: "top",
      hideOverlap: false,
    };
  };
}
