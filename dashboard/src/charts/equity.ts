import { number, signed } from "../formatters";
import { fitTreemapLabel, formatTreemapLabel } from "../treemap-labels";
import type { EquityPoint, IndustryPoint } from "../types";
import {
  chartTextSize,
  colors,
  escapeHtml,
  fontFamily,
  heatColor,
  heatTextColor,
  rem,
  tooltip,
} from "./common";
import { setChart, setEmpty } from "./charting";

interface GaugeLayout {
  centers: string[][];
  radius: string;
  showLabels: boolean;
}

export function renderEquityGauges(
  host: HTMLElement,
  points: EquityPoint[],
): void {
  renderEquityGaugeLayout(host, points, false);
}

export function renderEquityGaugesMobile(
  host: HTMLElement,
  points: EquityPoint[],
): void {
  renderEquityGaugeLayout(host, points, true);
}

function renderEquityGaugeLayout(
  host: HTMLElement,
  points: EquityPoint[],
  mobile: boolean,
): void {
  const valid = points.filter((point): point is EquityPoint & { change_pct: number } =>
    point.change_pct !== null && Number.isFinite(point.change_pct));
  if (!valid.length) {
    setEmpty(host, "权益行情数据暂缺");
    return;
  }

  const maxAbs = Math.max(
    1,
    Math.ceil(Math.max(...valid.map((point) => Math.abs(point.change_pct))) * 2) /
      2,
  );
  const sideCompactLayout: GaugeLayout = {
    centers: [
      ["11%", "22%"],
      ["61%", "22%"],
      ["11%", "72%"],
      ["61%", "72%"],
    ],
    radius: "29%",
    showLabels: false,
  };
  const stackedLayout: GaugeLayout = {
    centers: [
      ["25%", "15.5%"],
      ["75%", "15.5%"],
      ["25%", "65.5%"],
      ["75%", "65.5%"],
    ],
    radius: "28%",
    showLabels: true,
  };
  const regularLayout: GaugeLayout = {
    centers: [
      ["13%", "22%"],
      ["63%", "22%"],
      ["13%", "72%"],
      ["63%", "72%"],
    ],
    radius: "36%",
    showLabels: false,
  };
  const gaugeSeries = (layout: GaugeLayout) =>
    valid.slice(0, 4).map((point, index) => ({
      name: point.name,
      type: "gauge" as const,
      center: layout.centers[index],
      radius: layout.radius,
      min: -maxAbs,
      max: maxAbs,
      startAngle: 215,
      endAngle: -35,
      splitNumber: 4,
      axisLine: {
        roundCap: true,
        lineStyle: {
          width: 9,
          shadowBlur: 6,
          shadowColor: "rgba(32, 38, 34, 0.08)",
          color: [
            [0.24, colors.down],
            [0.48, "#a7dcc8"],
            [0.52, "#e8edf4"],
            [0.76, "#f4b3ad"],
            [1, colors.up],
          ],
        },
      },
      axisTick: { show: false },
      splitLine: {
        distance: -13,
        length: 6,
        lineStyle: { color: "rgba(255,255,255,.92)", width: 1 },
      },
      axisLabel: { show: false },
      pointer: {
        show: true,
        length: "50%",
        width: 3,
        itemStyle: {
          color: point.change_pct >= 0 ? colors.up : colors.down,
          shadowBlur: 5,
          shadowColor:
            point.change_pct >= 0
              ? "rgba(217,77,63,.24)"
              : "rgba(24,134,99,.24)",
        },
      },
      anchor: {
        show: true,
        size: 11,
        itemStyle: {
          color: colors.paper,
          borderColor:
            point.change_pct >= 0 ? colors.up : colors.down,
          borderWidth: 3,
          shadowBlur: 4,
          shadowColor: "rgba(32,38,34,.16)",
        },
      },
      title: {
        show: layout.showLabels,
        offsetCenter: layout.showLabels ? ["0%", "130%"] : [0, "48%"],
        color: colors.ink,
        fontFamily,
        fontSize: layout.showLabels
          ? Math.max(13, chartTextSize * 0.875)
          : Math.max(11, chartTextSize * 0.75),
        fontWeight: layout.showLabels ? 700 : 650,
        align: "center",
      },
      detail: layout.showLabels
        ? {
            show: true,
            offsetCenter: ["0%", "185%"],
            align: "center",
            formatter: `{close|${number(point.close, 2)}}  {change|${signed(point.change_pct, "%")}}`,
            rich: {
              close: {
                color: colors.ink,
                fontFamily,
                fontSize: Math.max(13, chartTextSize * 0.875),
                fontWeight: 800,
                lineHeight: Math.round(chartTextSize * 1.05),
              },
              change: {
                color: point.change_pct >= 0 ? colors.up : colors.down,
                fontFamily,
                fontSize: Math.max(13, chartTextSize * 0.875),
                fontWeight: 800,
                lineHeight: Math.round(chartTextSize * 1.05),
              },
            },
          }
        : { show: false },
      data: [{ value: point.change_pct, name: point.name }],
    }));

  setChart(host, {
    animationDuration: 280,
    aria: { enabled: true, description: "A股四个主要指数红绿方向仪表盘" },
    tooltip: {
      ...tooltip,
      trigger: "item",
      formatter: (params: unknown) => {
        const item = params as { seriesName: string };
        const point = valid.find((candidate) => candidate.name === item.seriesName);
        if (!point) return "";
        return `<strong>${escapeHtml(point.name)}</strong><br>收报 ${number(point.close, 2)}<br>涨跌 ${signed(point.change_pct, "%")}`;
      },
    },
    series: gaugeSeries(mobile ? stackedLayout : regularLayout),
    ...(mobile
      ? {}
      : {
          media: [
            {
              query: { maxWidth: 399 },
              option: { series: gaugeSeries(sideCompactLayout) },
            },
            {
              option: { series: gaugeSeries(regularLayout) },
            },
          ],
        }),
  });
}

export function renderIndustryTreemap(
  host: HTMLElement,
  points: IndustryPoint[],
): void {
  const valid = points.filter(
    (point): point is IndustryPoint & { market_cap_yuan: number; change_pct: number } =>
      point.market_cap_yuan !== null && Number.isFinite(point.market_cap_yuan) && point.market_cap_yuan > 0 &&
      point.change_pct !== null && Number.isFinite(point.change_pct),
  );
  if (!valid.length) {
    setEmpty(host, "行业数据暂缺");
    return;
  }
  const maxAbs = Math.max(
    ...valid.map((point) => Math.abs(point.change_pct)),
    0.01,
  );
  const totalMarketCap = valid.reduce(
    (sum, point) => sum + point.market_cap_yuan,
    0,
  );
  const chartArea = Math.max(
    host.clientWidth * host.clientHeight,
    1,
  );
  const fontSizeByName = new Map(
    valid.map((point) => {
      const estimatedArea =
        chartArea * (point.market_cap_yuan / totalMarketCap);
      const fontSize = Math.min(
        rem(1.75),
        Math.max(
          rem(0.625),
          Math.sqrt(estimatedArea) / 7.25,
        ),
      );
      return [point.name, fontSize] as const;
    }),
  );
  const labelTextByName = new Map(
    valid.map((point) => {
      return [
        point.name,
        formatTreemapLabel(
          point.name,
          signed(point.change_pct, "%"),
        ),
      ] as const;
    }),
  );
  setChart(host, {
    animationDuration: 300,
    aria: {
      enabled: true,
      description: "申万一级行业涨跌幅与总市值矩形树图",
    },
    tooltip: {
      ...tooltip,
      formatter: (params: unknown) => {
        const item = params as {
          data: { name: string; change: number; value: number };
        };
        return `<strong>${escapeHtml(item.data.name)}</strong><br>涨跌 ${signed(item.data.change, "%")}<br>总市值 ${number(item.data.value / 1e12, 2)} 万亿元`;
      },
    },
    series: [
      {
        type: "treemap",
        squareRatio: 1,
        sort: "desc",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        visibleMin: 0,
        childrenVisibleMin: 0,
        label: {
          show: false,
          fontFamily,
          fontSize: 8,
          lineHeight: 10,
          fontWeight: 600,
          overflow: "truncate",
          ellipsis: "",
        },
        labelLayout: (params: {
          text: string;
          rect: { width: number; height: number };
        }) => {
          const fontSize =
            fontSizeByName.get(params.text.split("\n")[0] ?? "") ??
            chartTextSize;
          const fitted = fitTreemapLabel(params.text, params.rect, fontSize);
          if (!fitted.visible) {
            return { width: 0, height: 0, fontSize: 0 };
          }
          return {
            width: fitted.width,
            height: fitted.height,
            fontSize: fitted.fontSize,
            lineHeight: fitted.lineHeight,
            hideOverlap: false,
          };
        },
        itemStyle: {
          borderColor: "transparent",
          borderWidth: 0,
          gapWidth: 0,
        },
        data: valid.map((point) => {
          const fontSize = fontSizeByName.get(point.name) ?? chartTextSize;
          const labelText = labelTextByName.get(point.name) ?? point.name;
          return {
            name: point.name,
            value: point.market_cap_yuan,
            change: point.change_pct,
            itemStyle: { color: heatColor(point.change_pct, maxAbs) },
            label: {
              show: true,
              color: heatTextColor(point.change_pct, maxAbs),
              fontSize,
              lineHeight: fontSize * 1.25,
              overflow: "truncate",
              ellipsis: "",
              formatter: labelText,
            },
          };
        }),
      },
    ],
  });
}
