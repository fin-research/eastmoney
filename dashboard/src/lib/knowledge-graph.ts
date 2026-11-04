export type NodeKind = "policy" | "macro" | "market" | "sector" | "event";
export type CauseMove = "rise" | "fall" | "occur";
export type EffectMove = "rise" | "fall";
export type EdgeTrend = "new" | "rising" | "steady" | "fading";

export interface KgNode {
  key: string;
  label: string;
  kind: NodeKind;
  weight: number;
  articleCount: number;
  lastSeenAt: string;
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
