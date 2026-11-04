import { z } from "zod";

import {
  parseHotspotAnalysis,
  type HotspotAnalysis,
  type HotspotApiResponse,
  type HotspotScope,
} from "$lib/hotspots";
import {
  AI_GATEWAY_MODEL,
  generateAiGatewayObject,
} from "./ai-gateway.ts";
import { saveHotspotSnapshot } from "./hotspot-snapshots.ts";

const HOTSPOT_MODEL = AI_GATEWAY_MODEL;
const PROMPT_VERSION = "d1-hotspots-v11-graph-nodes";
const HOTSPOT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_NODES_PER_CARD = 3;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 480;
const MAX_NODE_LABEL_CHARS = 40;
const MAX_NODE_FIELD_CHARS = 240;
export const hotspotResponseSchema = z
  .object({
    marketSummary: z
      .string()
      .min(1)
      .describe("简明的股债市场热点总览"),
    hotspots: z
      .array(
        z
          .object({
            keyword: z.string().min(2).max(8).describe("2到8字的具体主题"),
            heat: z.number().int().min(0).max(100).describe("综合影响热度"),
            articleIds: z
              .array(z.string().min(1))
              .min(1)
              .describe("只引用输入证据卡片中的articleId"),
          })
          .strict(),
      )
      .min(8)
      .max(15)
      .describe("按综合影响降序排列的8到15个热点"),
  })
  .strict();

type CompactHotspotOutput = z.infer<typeof hotspotResponseSchema>;

export const hotspotOutputSchema = hotspotResponseSchema;

interface ArticleRow {
  id: string;
  title: string;
  summary: string;
  importance: number;
  published_at: string;
  updated_at: string;
}

interface NodeRow {
  article_id: string;
  ordinal: number;
  label: string;
  kind: string;
  fact: string;
  impact: string;
}

interface EvidenceCard extends ArticleRow {
  nodes: Array<Omit<NodeRow, "article_id">>;
}

export type HotspotRequestScope =
  | { mode: "rolling"; rollingCount: number }
  | { mode: "range"; startDate: string; endDate: string };

const AGGREGATE_SYSTEM = `你是服务于专业投资者的中国股债市场研究员。必须开启内部思考，但只做简短的事件归并、同义词统一、证据交叉验证和热度排序；不要输出思考过程。

输入是第一阶段产生的结构化证据卡片，不包含完整原文。只能使用输入的标题、summary、importance、nodes 和 articleId，不得补充常识、旧闻或模型知识。合并同一驱动和同源观点，但保留有证据支持的不同主题；必须输出 8-15 个热点。

严格遵循响应 JSON Schema 输出，不要输出思考过程、Markdown 或 Schema 以外字段。字段语义和数量约束以 Schema 为准。`;

export async function generateMarketHotspots(
  env: Env,
  requestScope: HotspotRequestScope,
  options: { signal?: AbortSignal; onProgress?: (summary: string) => void } = {},
): Promise<HotspotApiResponse> {
  options.signal?.throwIfAborted();
  const cards = await loadEvidenceCards(env.DB, requestScope);
  if (cards.length === 0) {
    throw new HotspotError(404, "所选范围内尚无已完成特征抽取的文章");
  }
  const articleIds = cards.map((card) => card.id);
  const date = cards[0]!.published_at.slice(0, 10);
  const scope = resolvedScope(requestScope, cards);
  const fingerprint = await createFingerprint(cards);

  const output = await generateAiGatewayObject(
    {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID || "default",
      token: env.CF_AIG_TOKEN,
    },
    buildAggregateMessages(cards),
    hotspotOutputSchema,
    "market_hotspots",
    {
      signal: options.signal,
      ...(options.onProgress ? {
        onReasoningSummary: (summary: { id: string; text: string }) => options.onProgress?.(summary.text),
      } : {}),
      promptCacheKey: `market-hotspots:${PROMPT_VERSION}`,
      requestTimeoutMs: HOTSPOT_REQUEST_TIMEOUT_MS,
      taskType: "generation",
      metadata: {
        date,
        evidence_scope: requestScopeLabel(requestScope),
        prompt_version: PROMPT_VERSION,
        tags: "market-hotspots,stage:aggregate-d1-v4",
      },
    },
  );
  const analysis = parseHotspotAnalysis(
    JSON.stringify(expandCompactHotspotOutput(output, cards)),
    { date, articleIds },
  );
  const generatedAt = new Date().toISOString();
  const payload = JSON.stringify(analysis);

  options.signal?.throwIfAborted();
  await saveHotspotSnapshot(env.DB, {
    inputFingerprint: fingerprint,
    generatedAt,
    model: HOTSPOT_MODEL,
    scope,
    payload,
  });

  return withMetadata(analysis, generatedAt, HOTSPOT_MODEL, false, scope);
}

async function loadEvidenceCards(
  database: Env["DB"],
  scope: HotspotRequestScope,
): Promise<EvidenceCard[]> {
  const articleStatement =
    scope.mode === "rolling"
      ? database
          .prepare(
            `SELECT a.id, a.title, a.summary, a.importance, a.published_at, a.updated_at
             FROM article a
             WHERE a.summary IS NOT NULL
               AND a.importance IS NOT NULL
               AND EXISTS (SELECT 1 FROM article_node k WHERE k.article_id = a.id)
             ORDER BY a.published_at DESC, a.id DESC
             LIMIT ?`,
          )
          .bind(scope.rollingCount)
      : database
          .prepare(
            `SELECT a.id, a.title, a.summary, a.importance, a.published_at, a.updated_at
             FROM article a
             WHERE substr(a.published_at, 1, 10) BETWEEN ? AND ?
               AND a.summary IS NOT NULL
               AND a.importance IS NOT NULL
               AND EXISTS (SELECT 1 FROM article_node k WHERE k.article_id = a.id)
             ORDER BY a.published_at DESC, a.id DESC
             LIMIT 100`,
          )
          .bind(scope.startDate, scope.endDate);
  const articlesResult = await articleStatement.all<ArticleRow>();
  const articles: ArticleRow[] = articlesResult.results ?? [];
  if (articles.length === 0) return [];
  const placeholders = articles.map(() => "?").join(", ");
  const nodesResult = await database
    .prepare(
      `SELECT article_id, ordinal, label, kind, fact, impact
       FROM article_node
       WHERE article_id IN (${placeholders})
       ORDER BY article_id ASC, ordinal ASC`,
    )
    .bind(...articles.map((article) => article.id))
    .all<NodeRow>();
  const nodes: NodeRow[] = nodesResult.results ?? [];
  const nodesByArticle = new Map<string, EvidenceCard["nodes"]>();
  for (const node of nodes) {
    const group = nodesByArticle.get(node.article_id) ?? [];
    group.push({
      ordinal: node.ordinal,
      label: node.label,
      kind: node.kind,
      fact: node.fact,
      impact: node.impact,
    });
    nodesByArticle.set(node.article_id, group);
  }
  return articles
    .map((article) => ({
      ...article,
      nodes: nodesByArticle.get(article.id) ?? [],
    }))
    .filter((article) => article.nodes.length > 0);
}

function buildAggregateMessages(
  cards: EvidenceCard[],
): Array<{ role: "system" | "user"; content: string }> {
  const evidence = cards.map((card) => ({
    articleId: card.id,
    title: truncate(card.title, MAX_TITLE_CHARS),
    summary: truncate(card.summary, MAX_SUMMARY_CHARS),
    importance: card.importance,
    nodes: card.nodes.slice(0, MAX_NODES_PER_CARD).map((node) => ({
      label: truncate(node.label, MAX_NODE_LABEL_CHARS),
      fact: truncate(node.fact, MAX_NODE_FIELD_CHARS),
      impact: truncate(node.impact, MAX_NODE_FIELD_CHARS),
    })),
  }));
  return [
    { role: "system", content: AGGREGATE_SYSTEM },
    {
      role: "user",
      content: [
        "以下 JSON 是全部可用证据卡片。请先在内部完成归并和排序，再输出结果。",
        JSON.stringify({ evidenceCards: evidence }),
        "严格遵循响应 JSON Schema；articleIds 只能引用上面的 articleId，按综合影响排序。不要输出思考过程、Markdown 或其他字段。",
      ].join("\n"),
    },
  ];
}

function expandCompactHotspotOutput(
  value: CompactHotspotOutput,
  cards: EvidenceCard[],
): Record<string, unknown> {
  const rows = value.hotspots;
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const candidates = cards
    .flatMap((card) => card.nodes.map((node) => ({ card, node })))
    .sort((left, right) => right.card.importance - left.card.importance);
  const usedKeywords = new Set<string>();
  const compactRows: Array<{
    keyword: string;
    heat: number;
    articleIds: string[];
    fallback?: boolean;
  }> = [];

  for (const row of rows) {
    const keyword = textValue(row.keyword, 40);
    if (!keyword) continue;
    const keywordKey = normalizeKeyword(keyword);
    if (usedKeywords.has(keywordKey)) continue;
    const articleIds = validArticleIds(row.articleIds, cardById);
    const relatedIds = articleIds.length
      ? articleIds
      : cards.filter((card) => cardMatchesKeyword(card, keyword)).map((card) => card.id);
    const fallbackIds = relatedIds.length ? relatedIds : [cards[0]!.id];
    const heat =
      typeof row.heat === "number" && Number.isFinite(row.heat)
        ? Math.round(Math.max(0, Math.min(100, row.heat)))
        : 0;
    usedKeywords.add(keywordKey);
    compactRows.push({ keyword, heat, articleIds: [...new Set(fallbackIds)] });
  }

  for (const candidate of candidates) {
    if (compactRows.length >= 8) break;
    const keyword = candidate.node.label.trim();
    const keywordKey = normalizeKeyword(keyword);
    if (!keyword || usedKeywords.has(keywordKey)) continue;
    usedKeywords.add(keywordKey);
    compactRows.push({
      keyword,
      heat: 0,
      articleIds: [candidate.card.id],
      fallback: true,
    });
  }

  return {
    marketSummary: textValue(value.marketSummary) || truncate(cards[0]!.summary, 1_200),
    hotspots: compactRows.map((row) => {
      const evidenceCards = row.articleIds
        .map((id) => cardById.get(id))
        .filter((card): card is EvidenceCard => Boolean(card));
      const relatedKeywords = evidenceCards.flatMap((card) =>
        card.nodes.filter(
          (node) =>
            normalizeKeyword(node.label) === normalizeKeyword(row.keyword) ||
            row.keyword.includes(node.label) ||
            node.label.includes(row.keyword),
        ),
      );
      const selectedKeywords = relatedKeywords.length
        ? relatedKeywords
        : evidenceCards.flatMap((card) => card.nodes).slice(0, 3);
      const evidence = evidenceCards.slice(0, 5).map((card) => {
        const keyword =
          selectedKeywords.find((item) =>
            card.nodes.some((candidate) => candidate.label === item.label),
          ) ?? card.nodes[0];
        return {
          articleId: card.id,
          evidence: truncate(
            keyword
              ? keyword.label + "：" + keyword.fact + "。" + keyword.impact
              : card.summary,
            500,
          ),
        };
      });
      const impacts = selectedKeywords.map((keyword) => keyword.impact);
      const fixedIncome = impacts.filter(isFixedIncomeImpact);
      const equities = impacts.filter(isEquitiesImpact);
      const drivers = [...new Set(selectedKeywords.map((keyword) => keyword.label))].slice(0, 8);
      const explanation = selectedKeywords.length
        ? "证据显示" +
          selectedKeywords
            .slice(0, 2)
            .map((keyword) => keyword.fact)
            .join("；") +
          "。" +
          selectedKeywords[0]!.impact
        : evidenceCards[0]?.summary ?? "证据不足";
      return {
        keyword: row.keyword,
        aliases: [],
        heat: row.heat,
        conflicts: [],
        explanation: truncate(explanation, 1_000),
        drivers: drivers.length ? drivers : [row.keyword],
        assetImpacts: {
          fixedIncome: truncate(fixedIncome.join("；") || "证据不足", 500),
          equities: truncate(equities.join("；") || "证据不足", 500),
        },
        evidence,
        confidence: evidence.length >= 2 && !row.fallback ? "high" : "medium",
      };
    }),
    relationships: [],
    watchItems: [],
  };
}

function textValue(value: unknown, maxLength?: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return maxLength === undefined ? text : text.slice(0, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function normalizeKeyword(value: string): string {
  return value.replaceAll(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function validArticleIds(
  value: unknown,
  cardById: Map<string, EvidenceCard>,
): string[] {
  const items = Array.isArray(value) ? value : [];
  const ids = items.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const articleId = (item as { articleId?: unknown }).articleId;
      return typeof articleId === "string" ? [articleId] : [];
    }
    return [];
  });
  return [...new Set(ids.filter((id) => cardById.has(id)))];
}

function cardMatchesKeyword(card: EvidenceCard, keyword: string): boolean {
  return (
    card.title.includes(keyword) ||
    card.summary.includes(keyword) ||
    card.nodes.some((item) => item.label.includes(keyword) || keyword.includes(item.label))
  );
}

function isFixedIncomeImpact(value: string): boolean {
  return /债|利率|收益率|资金|流动性|货币|曲线/.test(value);
}

function isEquitiesImpact(value: string): boolean {
  return /权益|股票|消费|地产|风险偏好|板块/.test(value);
}

async function createFingerprint(cards: EvidenceCard[]): Promise<string> {
  const source = JSON.stringify({ promptVersion: PROMPT_VERSION, cards });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function withMetadata(
  analysis: HotspotAnalysis,
  generatedAt: string,
  model: string,
  cached: boolean,
  scope: HotspotScope,
): HotspotApiResponse {
  return { ...analysis, generatedAt, model, cached, scope };
}

function resolvedScope(
  requestScope: HotspotRequestScope,
  cards: EvidenceCard[],
): HotspotScope {
  const published = cards.map((card) => card.published_at).sort();
  const common = {
    articleCount: cards.length,
    firstPublishedAt: published[0]!,
    lastPublishedAt: published.at(-1)!,
  };
  return requestScope.mode === "rolling"
    ? { ...common, mode: "rolling", rollingCount: requestScope.rollingCount }
    : { ...common, ...requestScope };
}

function requestScopeLabel(scope: HotspotRequestScope): string {
  return scope.mode === "rolling"
    ? `rolling:${scope.rollingCount}`
    : `range:${scope.startDate}:${scope.endDate}`;
}

export class HotspotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
