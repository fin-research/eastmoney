import { forceLayout, layoutGraph } from "../lib/graph-layout";
import {
  litSets,
  MOVE_GLYPH,
  nodeSize,
  type KgDay,
  type KgEdge,
  type KnowledgeGraphResponse,
  type NodeKind,
} from "../lib/knowledge-graph";
import { getChart, setChart, type ChartOption } from "./charting";
import { chartTextSize, colors, escapeHtml, fontFamily } from "./common";

/** Dark stage palette. Node colour carries the kind; edge colour carries the effect direction. */
export const GRAPH_STAGE = {
  background: "#0b1220",
  text: "#e6edf7",
  muted: "#8b9ab3",
  contested: "#f472b6",
} as const;

export const KIND_ORDER: readonly NodeKind[] = ["policy", "macro", "market", "sector", "event"];

export const KIND_STYLE: Record<NodeKind, { name: string; color: string }> = {
  policy: { name: "政策", color: "#5b9dff" },
  macro: { name: "宏观", color: "#f5b942" },
  market: { name: "市场", color: "#2dd4bf" },
  sector: { name: "板块", color: "#b794f6" },
  event: { name: "事件", color: "#94a3b8" },
};

export interface GraphView {
  node: string;
  edge: number | null;
  chain: number | null;
}

// Layout units are pixels of a typical stage, so symbol sizes and spacing agree after the view fits.
const LAYOUT_WIDTH = 760;
const LAYOUT_HEIGHT = 560;
const LABELLED_NODES = 14;

/** Mixes a #rrggbb colour toward white so the site's up/down colours stay readable on the dark stage. */
export function lighten(color: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number): number => {
    const base = (value >> shift) & 255;
    return Math.round(base + (255 - base) * amount);
  };
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

function edgeColor(edge: KgEdge): string {
  if (edge.contested) return GRAPH_STAGE.contested;
  return lighten(edge.effectMove === "rise" ? colors.up : colors.down, 0.4);
}

function edgeWidth(edge: KgEdge, max: number): number {
  return 1.6 + 3.4 * Math.sqrt(edge.weight / Math.max(max, 0.0001));
}

/** Parallel edges between one pair of nodes fan out instead of overlapping. */
function curveness(edges: readonly KgEdge[]): number[] {
  const seen = new Map<string, number>();
  return edges.map((edge) => {
    const key = [edge.source, edge.target].sort().join("|");
    const order = seen.get(key) ?? 0;
    seen.set(key, order + 1);
    const flip = edge.source < edge.target ? 1 : -1;
    return flip * (0.12 + order * 0.16);
  });
}

export function knowledgeGraphOption(graph: KnowledgeGraphResponse, view: GraphView): ChartOption {
  const maxCount = Math.max(1, ...graph.nodes.map((node) => node.articleCount));
  const maxWeight = Math.max(0.0001, ...graph.edges.map((edge) => edge.weight));
  const lit = litSets(graph, { node: view.node, edge: view.edge, chain: view.chain });
  const ranked = [...graph.nodes].sort((left, right) => right.articleCount - left.articleCount);
  const labelled = new Set(ranked.slice(0, LABELLED_NODES).map((node) => node.key));
  const curves = curveness(graph.edges);
  const textSize = Math.max(chartTextSize, 13);
  const levels = new Map([...layoutGraph(graph.nodes, graph.edges).nodes].map(([key, place]) => [key, place.level]));
  const positions = forceLayout(
    graph.nodes.map((node) => ({ key: node.key, radius: nodeSize(node.articleCount, maxCount) / 2 + 8 })),
    graph.edges,
    { width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT, levels },
  );

  const data = graph.nodes.map((node) => {
    const place = positions.get(node.key);
    const style = KIND_STYLE[node.kind];
    const size = nodeSize(node.articleCount, maxCount);
    const on = !lit || lit.nodes.has(node.key);
    const picked = node.key === view.node;
    return {
      id: node.key,
      // Links match nodes by name, so the stable key is the name and the label is shown by formatter.
      name: node.key,
      value: node.articleCount,
      category: KIND_ORDER.indexOf(node.kind),
      symbol: "circle",
      symbolSize: size,
      x: place?.x,
      y: place?.y,
      itemStyle: {
        color: style.color,
        opacity: on ? 1 : 0.1,
        borderColor: picked ? "#ffffff" : style.color,
        borderWidth: picked ? 3 : 1,
        shadowBlur: on ? 10 + size * 0.45 : 0,
        shadowColor: style.color,
      },
      label: {
        show: lit ? lit.nodes.has(node.key) : labelled.has(node.key),
        position: "bottom" as const,
        distance: 4,
        formatter: node.label,
      },
    };
  });

  const links = graph.edges.map((edge, index) => {
    const on = !lit || lit.edges.has(index);
    return {
      source: edge.source,
      target: edge.target,
      value: edge.weight,
      lineStyle: {
        color: edgeColor(edge),
        width: edgeWidth(edge, maxWeight) + (lit && on ? 1.2 : 0),
        type: edge.contested ? ("dotted" as const) : edge.observed === 0 ? ("dashed" as const) : ("solid" as const),
        opacity: on ? (lit ? 1 : edge.authorCount < 2 ? 0.5 : 0.85) : 0.06,
        curveness: curves[index],
      },
    };
  });

  return {
    animationDurationUpdate: 240,
    legend: {
      data: KIND_ORDER.map((kind) => ({ name: KIND_STYLE[kind].name, icon: "circle" })),
      left: 12,
      top: 10,
      itemWidth: 14,
      itemHeight: 14,
      itemGap: 14,
      inactiveColor: "#44516a",
      textStyle: { color: GRAPH_STAGE.text, fontFamily, fontSize: textSize },
    },
    tooltip: {
      confine: true,
      backgroundColor: "rgba(15, 23, 42, 0.96)",
      borderColor: "#26334d",
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: GRAPH_STAGE.text, fontFamily, fontSize: textSize },
      formatter: (params: { dataType?: string; dataIndex?: number; data?: { name?: string; value?: number; category?: number; source?: string; target?: string } }) => {
        const names = new Map(graph.nodes.map((node) => [node.key, node.label]));
        if (params.dataType === "node" && params.data) {
          const kind = KIND_ORDER[params.data.category ?? 0] ?? "event";
          return `<b>${escapeHtml(names.get(params.data.name ?? "") ?? params.data.name)}</b><br/>${KIND_STYLE[kind].name} · ${params.data.value} 篇研报`;
        }
        // Parallel edges share endpoints, so the link index is the only reliable key.
        const edge = graph.edges[params.dataIndex ?? -1];
        if (!edge) return "";
        return `<b>${escapeHtml(names.get(edge.source))}${MOVE_GLYPH[edge.sourceMove]} → ${escapeHtml(names.get(edge.target))}${MOVE_GLYPH[edge.effectMove]}</b><br/>${edge.articleIds.length} 篇研报 · ${edge.authorCount} 家机构${edge.contested ? " · 多空冲突" : ""}`;
      },
    },
    series: [
      {
        type: "graph",
        layout: "none",
        roam: true,
        nodeScaleRatio: 1,
        draggable: true,
        scaleLimit: { min: 0.35, max: 6 },
        categories: KIND_ORDER.map((kind) => ({
          name: KIND_STYLE[kind].name,
          symbol: "circle",
          itemStyle: { color: KIND_STYLE[kind].color },
        })),
        data,
        links,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: [0, 9],
        labelLayout: { hideOverlap: true },
        label: {
          color: GRAPH_STAGE.text,
          fontFamily,
          fontSize: textSize,
          textBorderColor: GRAPH_STAGE.background,
          textBorderWidth: 3,
        },
        emphasis: {
          focus: lit ? "none" : "adjacency",
          scale: 1.12,
          label: { show: true },
          lineStyle: { width: 4, opacity: 1 },
        },
        lineStyle: { opacity: 0.7 },
      },
    ],
  };
}

const drawn = new WeakMap<HTMLElement, KnowledgeGraphResponse>();

/**
 * First draw, or a new graph, builds the chart and its layout from scratch. A selection change
 * on the same graph merges in the new styles, so nodes keep their positions and zoom.
 */
export function renderKnowledgeGraph(host: HTMLElement, graph: KnowledgeGraphResponse, view: GraphView): void {
  const option = knowledgeGraphOption(graph, view);
  const chart = getChart(host);
  if (chart && drawn.get(host) === graph) {
    chart.setOption(option);
    return;
  }
  drawn.set(host, graph);
  setChart(host, option);
}

/** Moves the view onto a node by its current layout position. */
export function focusKnowledgeNode(host: HTMLElement, key: string, graph: KnowledgeGraphResponse): void {
  const chart = getChart(host);
  if (!chart) return;
  const index = graph.nodes.findIndex((node) => node.key === key);
  if (index < 0) return;
  const model = (chart as unknown as { getModel(): { getSeriesByIndex(i: number): { getData(): { getItemLayout(i: number): number[] | undefined } } } }).getModel();
  const position = model.getSeriesByIndex(0).getData().getItemLayout(index);
  if (!position) return;
  chart.setOption({ series: [{ center: position, zoom: 1.7 }] });
}

export function zoomKnowledgeGraph(host: HTMLElement, factor: number): void {
  const chart = getChart(host);
  // graphRoam has no default origin; without one the view transform becomes NaN.
  chart?.dispatchAction({ type: "graphRoam", zoom: factor, originX: chart.getWidth() / 2, originY: chart.getHeight() / 2 });
}

export function resetKnowledgeGraphView(host: HTMLElement): void {
  getChart(host)?.setOption({ series: [{ center: null, zoom: 1 }] });
}

export interface TimelineRange {
  from: number;
  to: number;
}

/** Daily claim counts as bars; days inside the chosen range are bright, the rest recede. */
export function timelineOption(days: readonly KgDay[], range: TimelineRange): ChartOption {
  return {
    animation: false,
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: "category", data: days.map((day) => day.date), show: false, boundaryGap: true },
    yAxis: { type: "value", show: false },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "rgba(15, 23, 42, 0.96)",
      borderColor: "#26334d",
      borderWidth: 1,
      textStyle: { color: GRAPH_STAGE.text, fontFamily, fontSize: Math.max(chartTextSize, 12) },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const day = days[params[0]?.dataIndex ?? 0];
        return day ? `${day.date}<br/>${day.claims} 条主张 · ${day.articles} 篇研报` : "";
      },
    },
    series: [
      {
        type: "bar",
        barCategoryGap: "18%",
        data: days.map((day, index) => ({
          value: day.claims,
          itemStyle: {
            color: index >= range.from && index <= range.to ? "#5b9dff" : "#2a3753",
            borderRadius: [2, 2, 0, 0],
          },
        })),
      },
    ],
  };
}

export function renderTimeline(host: HTMLElement, days: readonly KgDay[], range: TimelineRange): void {
  setChart(host, timelineOption(days, range));
}
