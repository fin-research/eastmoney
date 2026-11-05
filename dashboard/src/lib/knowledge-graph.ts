export type NodeKind = "policy" | "macro" | "market" | "sector" | "event";
export type CauseMove = "rise" | "fall" | "occur";
export type EffectMove = "rise" | "fall";
export type EdgeTrend = "new" | "rising" | "steady" | "fading";

export interface KgArticle {
  id: string;
  title: string;
  author: string;
  publishedAt: string;
}

export interface KgNode {
  key: string;
  label: string;
  kind: NodeKind;
  weight: number;
  articleCount: number;
  lastSeenAt: string;
  /** Newest articles whose claims mention the node. */
  articles: KgArticle[];
}

export interface KgClaim {
  articleId: string;
  title: string;
  author: string;
  publishedAt: string;
  mechanism: string;
  basis: "observed" | "expected";
}

export interface KgEdge {
  source: string;
  sourceMove: CauseMove;
  target: string;
  effectMove: EffectMove;
  weight: number;
  riseWeight: number;
  fallWeight: number;
  contested: boolean;
  trend: EdgeTrend;
  observed: number;
  expected: number;
  articleIds: string[];
  authorCount: number;
  lastSeenAt: string;
  claims: KgClaim[];
}

export interface KgChain {
  nodes: string[];
  /** Indexes into `edges`. */
  edges: number[];
  weight: number;
}

export interface KgDay {
  date: string;
  /** Articles that carry at least one claim that day. */
  articles: number;
  claims: number;
}

export interface KnowledgeGraphResponse {
  window: { start: string; end: string; anchor: string };
  coverage: {
    articleCount: number;
    claimArticleCount: number;
    claimCount: number;
    nodeCount: number;
    /** True when the row limit cut the window, so older claims may be missing. */
    truncated: boolean;
  };
  nodes: KgNode[];
  edges: KgEdge[];
  chains: KgChain[];
  /** Daily claim counts from the first day with claims (at least 14 days) to `window.end`, oldest first. */
  timeline: KgDay[];
}

export const MOVE_GLYPH: Record<CauseMove, string> = { rise: "↑", fall: "↓", occur: "●" };

/** Chains whose evidence overlaps the given articles, strongest first. */
export function matchingChains(graph: KnowledgeGraphResponse, articleIds: Iterable<string>, limit = 3): KgChain[] {
  const wanted = new Set(articleIds);
  return graph.chains
    .filter((chain) => chain.edges.some((index) => graph.edges[index]?.articleIds.some((id) => wanted.has(id))))
    .slice(0, limit);
}

/** `降准● → DR007↓ → 存单利率↓`: each node carries the direction the chain gives it. */
export function describeChain(graph: KnowledgeGraphResponse, chain: KgChain): string {
  const labels = new Map(graph.nodes.map((node) => [node.key, node.label]));
  const first = graph.edges[chain.edges[0]!];
  const parts = [`${labels.get(chain.nodes[0]!) ?? chain.nodes[0]}${first ? MOVE_GLYPH[first.sourceMove] : ""}`];
  chain.edges.forEach((edgeIndex, hop) => {
    const edge = graph.edges[edgeIndex];
    const key = chain.nodes[hop + 1]!;
    parts.push(`${labels.get(key) ?? key}${edge ? MOVE_GLYPH[edge.effectMove] : ""}`);
  });
  return parts.join(" → ");
}

export interface TracedPaths {
  nodes: Set<string>;
  edges: Set<number>;
  upstream: Set<number>;
  downstream: Set<number>;
}

/**
 * Everything that feeds into a node and everything it feeds, up to `maxHops` each way. A hop only
 * continues when the neighbouring edge starts from the direction the previous one ended in, the
 * same rule the chain finder uses. Edges directly touching the node are always included.
 */
export function tracePaths(graph: KnowledgeGraphResponse, key: string, maxHops = 3): TracedPaths {
  const result: TracedPaths = { nodes: new Set([key]), edges: new Set(), upstream: new Set(), downstream: new Set() };
  const outgoing = new Map<string, number[]>();
  const incoming = new Map<string, number[]>();
  graph.edges.forEach((edge, index) => {
    (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)!).push(index);
    (incoming.get(edge.target) ?? incoming.set(edge.target, []).get(edge.target)!).push(index);
  });

  const down = (node: string, previous: KgEdge | null, seen: string[], hops: number): void => {
    if (hops === maxHops) return;
    for (const index of outgoing.get(node) ?? []) {
      const edge = graph.edges[index]!;
      if (seen.includes(edge.target) || (previous && edge.sourceMove !== previous.effectMove)) continue;
      result.edges.add(index);
      result.downstream.add(index);
      result.nodes.add(edge.target);
      down(edge.target, edge, [...seen, edge.target], hops + 1);
    }
  };
  const up = (node: string, next: KgEdge | null, seen: string[], hops: number): void => {
    if (hops === maxHops) return;
    for (const index of incoming.get(node) ?? []) {
      const edge = graph.edges[index]!;
      if (seen.includes(edge.source) || (next && edge.effectMove !== next.sourceMove)) continue;
      result.edges.add(index);
      result.upstream.add(index);
      result.nodes.add(edge.source);
      up(edge.source, edge, [...seen, edge.source], hops + 1);
    }
  };
  down(key, null, [key], 0);
  up(key, null, [key], 0);
  return result;
}

/** Nodes and edges lit by an edge, a chain or a node's traced paths. */
export function litSets(
  graph: KnowledgeGraphResponse,
  selection: { node?: string; edge?: number | null; chain?: number | null },
): { nodes: Set<string>; edges: Set<number>; upstream?: Set<number>; downstream?: Set<number> } | null {
  if (selection.chain !== null && selection.chain !== undefined) {
    const chain = graph.chains[selection.chain];
    if (chain) return { nodes: new Set(chain.nodes), edges: new Set(chain.edges) };
  }
  if (selection.edge !== null && selection.edge !== undefined) {
    const edge = graph.edges[selection.edge];
    if (edge) return { nodes: new Set([edge.source, edge.target]), edges: new Set([selection.edge]) };
  }
  if (selection.node) {
    const traced = tracePaths(graph, selection.node);
    return { nodes: traced.nodes, edges: traced.edges, upstream: traced.upstream, downstream: traced.downstream };
  }
  return null;
}

const MIN_SIZE = 14;
const MAX_SIZE = 62;

/** Symbol size grows with the square root of mentions, so area tracks heat. */
export function nodeSize(count: number, max: number): number {
  if (max <= 0) return MIN_SIZE;
  return Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * Math.sqrt(Math.max(0, count) / max));
}
