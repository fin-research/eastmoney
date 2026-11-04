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
