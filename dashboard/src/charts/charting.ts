import * as echarts from "echarts/core";
import {
  BarChart,
  GaugeChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  AriaComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import type { LabelLineSegment } from "../label-placement";

echarts.use([
  AriaComponent,
  BarChart,
  GaugeChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  LabelLayout,
  LineChart,
  PieChart,
  RadarChart,
  RadarComponent,
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  TreemapChart,
  SVGRenderer,
]);

type ChartInstance = ReturnType<typeof echarts.init>;
export type ChartOption = Parameters<ChartInstance["setOption"]>[0];

const instances = new Map<HTMLElement, ChartInstance>();
let resizeObserver: ResizeObserver | null = null;

function getResizeObserver(): ResizeObserver | null {
  if (resizeObserver) return resizeObserver;
  if (typeof ResizeObserver === "undefined") return null;

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const host = entry.target as HTMLElement;
      const chart = instances.get(host);
      if (!chart) continue;
      chart.resize();
      setChartBounds(host, chart);
    }
  });
  return resizeObserver;
}

export function setChart(host: HTMLElement, option: ChartOption): ChartInstance {
  let chart = instances.get(host);
  if (!chart) {
    host.replaceChildren();
    chart = echarts.init(host, undefined, { renderer: "svg" });
    instances.set(host, chart);
    getResizeObserver()?.observe(host);
  }
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const boundedOption = {
    ...option,
    backgroundColor: "rgba(255,255,255,0)",
  };
  const resolvedOption = reduceMotion
    ? {
        ...boundedOption,
        animation: false,
        animationDuration: 0,
        animationDurationUpdate: 0,
      }
    : boundedOption;
  chart.setOption(resolvedOption, { notMerge: true });
  setChartBounds(host, chart);
  return chart;
}

export function seriesLineSegments(
  host: HTMLElement,
  seriesIndex: number,
  values: Array<[string | number, number]>,
  step?: "end",
): LabelLineSegment[] {
  const chart = instances.get(host);
  if (!chart || values.length < 2) return [];
  try {
    const pixels = values.map((value) => {
      const pixel = chart.convertToPixel({ seriesIndex }, value) as unknown;
      return Array.isArray(pixel) &&
        Number.isFinite(pixel[0]) &&
        Number.isFinite(pixel[1])
        ? { x: pixel[0] as number, y: pixel[1] as number }
        : null;
    });
    const segments: LabelLineSegment[] = [];
    for (let index = 1; index < pixels.length; index += 1) {
      const start = pixels[index - 1];
      const end = pixels[index];
      if (!start || !end) continue;
      if (step === "end") {
        segments.push({ x1: start.x, y1: start.y, x2: end.x, y2: start.y });
        segments.push({ x1: end.x, y1: start.y, x2: end.x, y2: end.y });
      } else {
        segments.push({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
      }
    }
    return segments;
  } catch {
    return [];
  }
}

function setChartBounds(host: HTMLElement, chart: ChartInstance): void {
  chart.setOption({
    graphic: [
      {
        id: "__chart-bounds__",
        type: "rect",
        shape: {
          x: 0,
          y: 0,
          width: host.clientWidth,
          height: host.clientHeight,
        },
        style: { fill: "rgba(255,255,255,0)" },
        silent: true,
        z: -10_000,
      },
    ],
  });
}

export function setEmpty(host: HTMLElement, message: string): void {
  disposeChart(host);
  const empty = document.createElement("div");
  empty.className = "empty-chart";
  empty.textContent = message;
  host.replaceChildren(empty);
}

export function disposeChart(host: HTMLElement): void {
  const chart = instances.get(host);
  if (!chart) return;
  resizeObserver?.unobserve(host);
  chart.dispose();
  instances.delete(host);
}
