import type {
  CauseMove,
  EdgeTrend,
  EffectMove,
  KgChain,
  KgClaim,
  KgDay,
  KgEdge,
  KgNode,
  KnowledgeGraphResponse,
  NodeKind,
} from "../knowledge-graph.ts";

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 3;
const RECENT_DAYS = 3;
const CONTESTED_RATIO = 0.3;
// The page draws at most this many edges, and chains are built only from them, so every
// listed chain and hot node is on screen.
const MAX_EDGES = 80;
const CHAIN_EDGE_POOL = MAX_EDGES;
const MAX_HOPS = 3;
const MAX_CHAINS = 10;
const CLAIMS_PER_EDGE = 5;
const ROW_LIMIT = 5000;
const NODE_ROW_LIMIT = 8000;
export const GRAPH_MAX_DAYS = 90;

// Common macro terms that models write in several ways. Keys are already node-normalized.
const ALIASES: Record<string, string> = {
  "10年期国债收益率": "10年国债收益率",
  "十年期国债收益率": "10年国债收益率",
  "十年国债收益率": "10年国债收益率",
  "10年期国债利率": "10年国债收益率",
  "10年国债利率": "10年国债收益率",
  "10y国债收益率": "10年国债收益率",
  "30年期国债收益率": "30年国债收益率",
  "三十年国债收益率": "30年国债收益率",
  "30年国债利率": "30年国债收益率",
  "存款准备金率下调": "降准",
  "下调存款准备金率": "降准",
  "降低存款准备金率": "降准",
  "下调政策利率": "降息",
  "政策利率下调": "降息",
  "人民币兑美元汇率": "人民币汇率",
  "美元兑人民币汇率": "人民币汇率",
  "沪深300指数": "沪深300",
  "央行逆回购投放": "隔夜逆回购投放",
  "央行逆回购净投放": "隔夜逆回购投放",
  "逆回购投放": "隔夜逆回购投放",
  "7天逆回购投放": "隔夜逆回购投放",
  "隔夜逆回购操作": "隔夜逆回购利率",
  "同业存单收益率": "1年期同业存单收益率",
  "美联储加息预期": "美联储加息",
  "降准降息": "降准降息预期",
};

export function normalizeNodeKey(label: string): string {
  const key = label.normalize("NFKC").replaceAll(/\s+/g, "").toLowerCase();
  return ALIASES[key] ?? key;
}

export interface ClaimRow {
  article_id: string;
  cause: string;
  cause_move: CauseMove;
  effect: string;
  effect_move: EffectMove;
  basis: "observed" | "expected";
  mechanism: string;
  title: string;
  author: string | null;
  published_at: string;
  importance: number | null;
}

export interface NodeRow {
  article_id: string;
  label: string;
  kind: NodeKind;
}

export interface GraphOptions {
  start: string;
  end: string;
  days: number;
  articleCount: number;
  claimArticleCount: number;
  truncated?: boolean;
  focus?: string;
}

interface EdgeAccumulator {
  source: string;
  sourceMove: CauseMove;
  target: string;
  rise: number;
  fall: number;
  recent: number;
  base: number;
  articles: Map<string, number>;
  authors: Set<string>;
  claims: Array<KgClaim & { time: number }>;
  observed: number;
  expected: number;
  lastSeen: number;
}

function time(value: string): number {
  return Date.parse(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mostFrequent<T extends string>(counts: Map<T, number>, fallback: T): T {
  let best: T = fallback;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function increment<T>(counts: Map<T, number>, value: T): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

export function buildKnowledgeGraph(
  claimRows: ClaimRow[],
  nodeRows: NodeRow[],
  options: GraphOptions,
): KnowledgeGraphResponse {
  const empty = {
    window: { start: options.start, end: options.end, anchor: "" },
    coverage: {
      articleCount: options.articleCount,
      claimArticleCount: options.claimArticleCount,
      claimCount: 0,
      nodeCount: 0,
      truncated: options.truncated ?? false,
    },
    nodes: [],
    edges: [],
    chains: [],
    timeline: [],
  } satisfies KnowledgeGraphResponse;
  if (claimRows.length === 0) return empty;

  // Anchor on the newest claim so weekends and holidays do not fade the whole window.
  const anchorMs = Math.max(...claimRows.map((row) => time(row.published_at)));
  const kindCounts = new Map<string, Map<NodeKind, number>>();
  for (const row of nodeRows) {
    const key = normalizeNodeKey(row.label);
    const counts = kindCounts.get(key) ?? new Map<NodeKind, number>();
    increment(counts, row.kind);
    kindCounts.set(key, counts);
  }

  const labelCounts = new Map<string, Map<string, number>>();
  const nodeArticles = new Map<string, Set<string>>();
  const nodeLastSeen = new Map<string, number>();
  const accumulators = new Map<string, EdgeAccumulator>();

  for (const row of claimRows) {
    const source = normalizeNodeKey(row.cause);
    const target = normalizeNodeKey(row.effect);
    if (source === target) continue;
    const published = time(row.published_at);
    const importance = (row.importance ?? 50) / 100;
    const ageDays = Math.max(0, (anchorMs - published) / DAY_MS);
    const weight = importance * 0.5 ** (ageDays / HALF_LIFE_DAYS);

    const key = `${source}|${row.cause_move}|${target}`;
    const edge = accumulators.get(key) ?? {
      source,
      sourceMove: row.cause_move,
      target,
      rise: 0,
      fall: 0,
      recent: 0,
      base: 0,
      articles: new Map<string, number>(),
      authors: new Set<string>(),
      claims: [],
      observed: 0,
      expected: 0,
      lastSeen: 0,
    };
    // Each article contributes one weight per edge direction.
    const articleKey = `${row.article_id}|${row.effect_move}`;
    if (edge.articles.has(articleKey)) continue;
    edge.articles.set(articleKey, weight);
    if (row.effect_move === "rise") edge.rise += weight;
    else edge.fall += weight;
    if (ageDays < RECENT_DAYS) edge.recent += importance;
    else edge.base += importance;
    if (row.author) edge.authors.add(row.author);
    if (row.basis === "observed") edge.observed += 1;
    else edge.expected += 1;
    edge.lastSeen = Math.max(edge.lastSeen, published);
    edge.claims.push({
      articleId: row.article_id,
      title: row.title,
      author: row.author ?? "",
      publishedAt: row.published_at,
      mechanism: row.mechanism,
      basis: row.basis,
      time: published,
    });
    accumulators.set(key, edge);

    for (const [nodeKey, label] of [[source, row.cause], [target, row.effect]] as const) {
      const counts = labelCounts.get(nodeKey) ?? new Map<string, number>();
      increment(counts, label.trim());
      labelCounts.set(nodeKey, counts);
      const articles = nodeArticles.get(nodeKey) ?? new Set<string>();
      articles.add(row.article_id);
      nodeArticles.set(nodeKey, articles);
      nodeLastSeen.set(nodeKey, Math.max(nodeLastSeen.get(nodeKey) ?? 0, published));
    }
  }

  const rest = Math.max(1, options.days - RECENT_DAYS);
  const allEdges: KgEdge[] = [...accumulators.values()].map((edge) => {
    const high = Math.max(edge.rise, edge.fall);
    const low = Math.min(edge.rise, edge.fall);
    const baseRate = (edge.base * RECENT_DAYS) / rest;
    let trend: EdgeTrend = "steady";
    if (edge.base === 0) trend = "new";
    else if (edge.recent >= baseRate * 1.5) trend = "rising";
    else if (edge.recent <= baseRate * 0.5) trend = "fading";
    return {
      source: edge.source,
      sourceMove: edge.sourceMove,
      target: edge.target,
      effectMove: edge.rise >= edge.fall ? "rise" : "fall",
      weight: round(edge.rise + edge.fall),
      riseWeight: round(edge.rise),
      fallWeight: round(edge.fall),
      contested: low > 0 && low >= high * CONTESTED_RATIO,
      trend,
      observed: edge.observed,
      expected: edge.expected,
      articleIds: [...new Set([...edge.articles.keys()].map((value) => value.split("|")[0]!))],
      authorCount: edge.authors.size,
      lastSeenAt: new Date(edge.lastSeen).toISOString(),
      claims: edge.claims
        .sort((left, right) => right.time - left.time)
        .slice(0, CLAIMS_PER_EDGE)
        .map(({ time: _time, ...claim }) => claim),
    };
  });
  allEdges.sort((left, right) => right.weight - left.weight || left.source.localeCompare(right.source));

  const pool = allEdges.slice(0, CHAIN_EDGE_POOL);
  let chains = findChains(pool);
  let edges = allEdges.slice(0, MAX_EDGES);

  const focus = options.focus ? normalizeNodeKey(options.focus) : "";
  if (focus) {
    const keys = new Set([...nodeArticles.keys()]);
    const matched = keys.has(focus) ? [focus] : [...keys].filter((key) => key.includes(focus));
    const matchedSet = new Set(matched);
    chains = chains.filter((chain) => chain.nodes.some((node) => matchedSet.has(node)));
    const onChain = new Set(chains.flatMap((chain) => chain.edgeRefs));
    edges = allEdges
      .filter((edge) => matchedSet.has(edge.source) || matchedSet.has(edge.target) || onChain.has(edge))
      .slice(0, MAX_EDGES);
  } else {
    const kept = new Set(edges);
    chains = chains.filter((chain) => chain.edgeRefs.every((edge) => kept.has(edge)));
  }

  const edgeIndex = new Map(edges.map((edge, index) => [edge, index]));
  const finalChains: KgChain[] = chains
    .filter((chain) => chain.edgeRefs.every((edge) => edgeIndex.has(edge)))
    .map((chain) => ({
      nodes: chain.nodes,
      edges: chain.edgeRefs.map((edge) => edgeIndex.get(edge)!),
      weight: chain.weight,
    }));

  const edgeNodeWeight = new Map<string, number>();
  for (const edge of edges) {
    for (const key of [edge.source, edge.target]) {
      edgeNodeWeight.set(key, (edgeNodeWeight.get(key) ?? 0) + edge.weight);
    }
  }
  const nodes: KgNode[] = [...edgeNodeWeight.entries()]
    .map(([key, weight]) => ({
      key,
      label: mostFrequent(labelCounts.get(key) ?? new Map([[key, 1]]), key),
      kind: mostFrequent(kindCounts.get(key) ?? new Map<NodeKind, number>(), "event"),
      weight: round(weight),
      articleCount: nodeArticles.get(key)?.size ?? 0,
      lastSeenAt: new Date(nodeLastSeen.get(key) ?? anchorMs).toISOString(),
    }))
    .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key));

  return {
    window: { start: options.start, end: options.end, anchor: new Date(anchorMs).toISOString() },
    coverage: {
      articleCount: options.articleCount,
      claimArticleCount: options.claimArticleCount,
      claimCount: claimRows.length,
      nodeCount: nodeArticles.size,
      truncated: options.truncated ?? false,
    },
    nodes,
    edges,
    chains: finalChains,
    timeline: [],
  };
}

interface RawChain {
  nodes: string[];
  edgeRefs: KgEdge[];
  weight: number;
}

/** Depth-first chains of at most three hops; each hop must continue the previous effect's direction. */
function findChains(pool: KgEdge[]): RawChain[] {
  const usable = pool.filter((edge) => !edge.contested);
  const bySource = new Map<string, KgEdge[]>();
  for (const edge of usable) {
    const list = bySource.get(edge.source) ?? [];
    list.push(edge);
    bySource.set(edge.source, list);
  }
  const found: RawChain[] = [];
  const walk = (nodes: string[], path: KgEdge[]): void => {
    if (path.length >= 2) {
      found.push({ nodes: [...nodes], edgeRefs: [...path], weight: Math.min(...path.map((edge) => edge.weight)) });
    }
    if (path.length === MAX_HOPS) return;
    const last = path.at(-1)!;
    for (const next of bySource.get(last.target) ?? []) {
      if (next.sourceMove !== last.effectMove || nodes.includes(next.target)) continue;
      walk([...nodes, next.target], [...path, next]);
    }
  };
  for (const edge of usable) walk([edge.source, edge.target], [edge]);

  const isSubPath = (small: RawChain, big: RawChain): boolean => {
    if (small.edgeRefs.length >= big.edgeRefs.length) return false;
    for (let offset = 0; offset + small.edgeRefs.length <= big.edgeRefs.length; offset += 1) {
      if (small.edgeRefs.every((edge, index) => edge === big.edgeRefs[offset + index])) return true;
    }
    return false;
  };
  return found
    .filter((chain) => !found.some((other) => isSubPath(chain, other)))
    .sort((left, right) => right.weight - left.weight || right.edgeRefs.length - left.edgeRefs.length)
    .slice(0, MAX_CHAINS);
}

export function shanghaiDate(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface GraphQuery {
  end: string;
  days: number;
  focus?: string;
}

export function fillTimeline(
  end: string,
  rows: Array<{ day: string; articles: number; claims: number }>,
): KgDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: GRAPH_MAX_DAYS }, (_, index) => {
    const date = addDays(end, index - (GRAPH_MAX_DAYS - 1));
    const row = byDay.get(date);
    return { date, articles: row?.articles ?? 0, claims: row?.claims ?? 0 };
  });
}

export async function loadKnowledgeGraph(database: Env["DB"], query: GraphQuery): Promise<KnowledgeGraphResponse> {
  const start = addDays(query.end, -(query.days - 1));
  const window = [start, query.end];
  const [claims, nodes, counts, daily] = await Promise.all([
    database
      .prepare(
        `SELECT c.article_id, c.cause, c.cause_move, c.effect, c.effect_move, c.basis, c.mechanism,
                a.title, a.author, a.published_at, a.importance
         FROM claim c JOIN article a ON a.id = c.article_id
         WHERE date(a.published_at, '+8 hours') BETWEEN ? AND ?
         ORDER BY a.published_at DESC, c.article_id ASC, c.ordinal ASC
         LIMIT ${ROW_LIMIT}`,
      )
      .bind(...window)
      .all<ClaimRow>(),
    database
      .prepare(
        `SELECT n.article_id, n.label, n.kind
         FROM node n JOIN article a ON a.id = n.article_id
         WHERE date(a.published_at, '+8 hours') BETWEEN ? AND ?
         ORDER BY a.published_at DESC
         LIMIT ${NODE_ROW_LIMIT}`,
      )
      .bind(...window)
      .all<NodeRow>(),
    database
      .prepare(
        `SELECT COUNT(*) AS article_count,
                SUM(EXISTS (SELECT 1 FROM claim c WHERE c.article_id = a.id)) AS claim_article_count
         FROM article a
         WHERE a.summary IS NOT NULL AND date(a.published_at, '+8 hours') BETWEEN ? AND ?`,
      )
      .bind(...window)
      .first<{ article_count: number; claim_article_count: number | null }>(),
    database
      .prepare(
        `SELECT date(a.published_at, '+8 hours') AS day,
                COUNT(DISTINCT c.article_id) AS articles, COUNT(*) AS claims
         FROM claim c JOIN article a ON a.id = c.article_id
         WHERE date(a.published_at, '+8 hours') BETWEEN ? AND ?
         GROUP BY day`,
      )
      .bind(addDays(query.end, -(GRAPH_MAX_DAYS - 1)), query.end)
      .all<{ day: string; articles: number; claims: number }>(),
  ]);
  const graph = buildKnowledgeGraph(claims.results ?? [], nodes.results ?? [], {
    start,
    end: query.end,
    days: query.days,
    articleCount: counts?.article_count ?? 0,
    claimArticleCount: counts?.claim_article_count ?? 0,
    truncated: (claims.results ?? []).length >= ROW_LIMIT,
    focus: query.focus,
  });
  graph.timeline = fillTimeline(query.end, daily.results ?? []);
  return graph;
}
