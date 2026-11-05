export interface LayoutNode {
  key: string;
  weight: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  weight: number;
}

export interface PlacedNode {
  key: string;
  x: number;
  y: number;
  level: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  nodes: Map<string, PlacedNode>;
}

const COLUMN_GAP = 96;
const ROW_GAP = 22;
const NODE_WIDTH = 148;
const NODE_HEIGHT = 44;
const PADDING = 16;
const MAX_LEVEL = 4;

/**
 * Left-to-right layers: a node sits one column right of its deepest cause. Levels are
 * capped, so feedback loops settle instead of growing without bound. Rows follow the
 * average row of the causes to keep most edges short.
 */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[]): GraphLayout {
  const level = new Map(nodes.map((node) => [node.key, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (edge.source === edge.target) continue;
      const next = Math.min(MAX_LEVEL, (level.get(edge.source) ?? 0) + 1);
      if ((level.get(edge.target) ?? 0) < next) {
        level.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const column = columns.get(level.get(node.key) ?? 0) ?? [];
    column.push(node);
    columns.set(level.get(node.key) ?? 0, column);
  }
  const levels = [...columns.keys()].sort((left, right) => left - right);
  const row = new Map<string, number>();
  const placed = new Map<string, PlacedNode>();
  let tallest = 0;

  levels.forEach((levelValue, columnIndex) => {
    const column = columns.get(levelValue)!;
    const barycenter = (node: LayoutNode): number => {
      const rows = edges
        .filter((edge) => edge.target === node.key && row.has(edge.source))
        .map((edge) => row.get(edge.source)!);
      return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : Number.POSITIVE_INFINITY;
    };
    column.sort(
      (left, right) =>
        barycenter(left) - barycenter(right) || right.weight - left.weight || left.key.localeCompare(right.key),
    );
    column.forEach((node, rowIndex) => {
      row.set(node.key, rowIndex);
      placed.set(node.key, {
        key: node.key,
        level: levelValue,
        x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + rowIndex * (NODE_HEIGHT + ROW_GAP),
      });
    });
    tallest = Math.max(tallest, column.length);
  });

  return {
    width: PADDING * 2 + levels.length * NODE_WIDTH + Math.max(0, levels.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + tallest * NODE_HEIGHT + Math.max(0, tallest - 1) * ROW_GAP,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    nodes: placed,
  };
}

export interface ForceNode {
  key: string;
  /** Collision radius in layout units. */
  radius: number;
}

export interface ForceOptions {
  width: number;
  height: number;
  /** Cause-to-effect levels from `layoutGraph`; they bias causes left and effects right. */
  levels?: Map<string, number>;
  iterations?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic force layout run to completion: repulsion, springs along edges, a weak pull
 * that keeps causes left of effects, gravity, and a final pass that separates overlapping nodes.
 */
export function forceLayout(
  nodes: ForceNode[],
  edges: LayoutEdge[],
  { width, height, levels, iterations = 320 }: ForceOptions,
): Map<string, { x: number; y: number }> {
  const random = seeded(nodes.length * 7919 + edges.length);
  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const maxLevel = Math.max(1, ...(levels ? [...levels.values()] : [1]));
  const x = nodes.map((node) => {
    const level = levels?.get(node.key) ?? 0;
    return width * (0.15 + (0.7 * level) / maxLevel) + (random() - 0.5) * width * 0.2;
  });
  const y = nodes.map(() => height * (0.15 + random() * 0.7));
  const linkList = edges
    .map((edge) => [index.get(edge.source), index.get(edge.target), edge.weight] as const)
    .filter((link): link is readonly [number, number, number] => link[0] !== undefined && link[1] !== undefined && link[0] !== link[1]);
  const maxWeight = Math.max(0.0001, ...edges.map((edge) => edge.weight));
  const area = width * height;
  const ideal = Math.sqrt(area / Math.max(1, nodes.length)) * 1.05;

  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    const limit = ideal * 0.6 * cooling + 0.5;
    const fx = new Array<number>(nodes.length).fill(0);
    const fy = new Array<number>(nodes.length).fill(0);

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        let dx = x[i]! - x[j]!;
        let dy = y[i]! - y[j]!;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const d = Math.sqrt(d2);
        const reach = nodes[i]!.radius + nodes[j]!.radius + 6;
        const push = (ideal * ideal * 0.035) / d + (d < reach ? (reach - d) * 0.6 : 0);
        fx[i]! += (dx / d) * push;
        fy[i]! += (dy / d) * push;
        fx[j]! -= (dx / d) * push;
        fy[j]! -= (dy / d) * push;
      }
    }

    for (const [a, b, weight] of linkList) {
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = (nodes[a]!.radius + nodes[b]!.radius) * 1.2 + ideal * (0.9 - 0.5 * (weight / maxWeight));
      const pull = (d - rest) * 0.22;
      fx[a]! += (dx / d) * pull;
      fy[a]! += (dy / d) * pull;
      fx[b]! -= (dx / d) * pull;
      fy[b]! -= (dy / d) * pull;
    }

    nodes.forEach((node, i) => {
      const level = levels?.get(node.key) ?? 0;
      const anchor = width * (0.15 + (0.7 * level) / maxLevel);
      fx[i]! += (anchor - x[i]!) * 0.08;
      fx[i]! += (width / 2 - x[i]!) * 0.04;
      fy[i]! += (height / 2 - y[i]!) * 0.12;
    });

    for (let i = 0; i < nodes.length; i += 1) {
      const magnitude = Math.hypot(fx[i]!, fy[i]!) || 1;
      const move = Math.min(limit, magnitude * 0.35);
      x[i]! = clamp(x[i]! + (fx[i]! / magnitude) * move, nodes[i]!.radius, width - nodes[i]!.radius);
      y[i]! = clamp(y[i]! + (fy[i]! / magnitude) * move, nodes[i]!.radius, height - nodes[i]!.radius);
    }
  }

  // Stretch the bulk of the nodes (3rd to 97th percentile) over the full stage so a lone outlier
  // cannot leave the rest bunched up; outliers end at the edge and the pass below separates them.
  const edgeGap = Math.max(0, ...nodes.map((node) => node.radius));
  for (const [axis, size] of [[x, width], [y, height]] as const) {
    if (axis.length < 2) continue;
    const sorted = [...axis].sort((a, b) => a - b);
    const low = sorted[Math.floor(0.03 * (sorted.length - 1))]!;
    const high = sorted[Math.ceil(0.97 * (sorted.length - 1))]!;
    const room = size - 2 * edgeGap;
    if (high - low < 1 || room <= 0) continue;
    const scale = room / (high - low);
    axis.forEach((value, i) => {
      axis[i] = clamp(edgeGap + (value - low) * scale, nodes[i]!.radius, size - nodes[i]!.radius);
    });
  }

  for (let pass = 0; pass < 120; pass += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = x[j]! - x[i]!;
        const dy = y[j]! - y[i]!;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const need = nodes[i]!.radius + nodes[j]!.radius + 6;
        if (d >= need) continue;
        const shift = (need - d) / 2;
        const ux = dx / d || 1;
        const uy = dy / d || 0;
        x[i]! = clamp(x[i]! - ux * shift, nodes[i]!.radius, width - nodes[i]!.radius);
        y[i]! = clamp(y[i]! - uy * shift, nodes[i]!.radius, height - nodes[i]!.radius);
        x[j]! = clamp(x[j]! + ux * shift, nodes[j]!.radius, width - nodes[j]!.radius);
        y[j]! = clamp(y[j]! + uy * shift, nodes[j]!.radius, height - nodes[j]!.radius);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return new Map(nodes.map((node, i) => [node.key, { x: x[i]!, y: y[i]! }]));
}
