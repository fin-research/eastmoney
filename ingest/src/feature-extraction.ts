import { z } from "zod";

import {
  AI_GATEWAY_MODEL,
  generateAiGatewayObject,
  type AiGatewayTaskType,
  type AiGatewayMessage,
} from "./ai-gateway";

export const ARTICLE_FEATURE_MODEL = AI_GATEWAY_MODEL;
export const ARTICLE_FEATURE_PROMPT_VERSION = "v6-causal-claims";

const MAX_NODES = 10;
export const MAX_CLAIMS = 6;
export const RECENT_LABEL_DAYS = 14;
export const RECENT_LABEL_LIMIT = 40;

export const NODE_KINDS = ["policy", "macro", "market", "sector", "event"] as const;
export const CAUSE_MOVES = ["rise", "fall", "occur"] as const;
export const EFFECT_MOVES = ["rise", "fall"] as const;
export const CLAIM_BASES = ["observed", "expected"] as const;

const nodeSchema = z
  .object({
    label: z.string().min(2).max(16).describe("具体、无方向的市场概念，如DR007、降准、银行股"),
    kind: z.enum(NODE_KINDS).describe("policy政策、macro宏观数据、market利率汇率或资产价格、sector行业板块、event事件"),
    fact: z.string().min(1).max(400).describe("原文事实或明确观点"),
    impact: z
      .string()
      .min(1)
      .max(500)
      .describe("受影响资产或行业、明确方向、机制或成立条件"),
  })
  .strict();

// Length limits are enforced by normalizeClaims, which drops a bad claim. They are
// not part of the model schema, because a schema failure would discard the whole article.
const claimSchema = z
  .object({
    cause: z.string().describe("原因节点的label，必须逐字取自nodes"),
    causeMove: z.enum(CAUSE_MOVES).describe("原因的变化方向；政策动作或事件用occur"),
    effect: z.string().describe("结果节点的label，必须逐字取自nodes"),
    effectMove: z.enum(EFFECT_MOVES).describe("结果的变化方向"),
    basis: z.enum(CLAIM_BASES).describe("observed表示正文说结果已发生，expected表示预期或推断"),
    mechanism: z.string().describe("正文给出的传导机制或成立条件，不超过160字"),
  })
  .strict();

export const articleFeatureSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(500)
      .describe("逐字复制输入标题，不得改写"),
    author: z
      .string()
      .max(160)
      .describe("正文明确出现的机构或研究业务团队；无法确认时为空字符串"),
    summary: z
      .string()
      .min(1)
      .max(55)
      .describe("一句话概括核心结论、关键依据和首要市场影响，不超过55个汉字"),
    importance: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("按提示词五项评分相加得到的0到100整数"),
    nodes: z
      .array(nodeSchema)
      .min(1)
      .max(MAX_NODES)
      .describe("按市场影响重要性降序排列的互不重复节点"),
    claims: z
      .array(claimSchema)
      .describe("正文明确陈述的因果主张，最多6条，没有则为空数组"),
  })
  .strict();

export type ArticleFeatures = z.infer<typeof articleFeatureSchema>;
export type ArticleNode = ArticleFeatures["nodes"][number];
export type ArticleClaim = z.infer<typeof claimSchema>;

/** Directionless node key: the same concept written differently maps to one key. */
export function nodeKey(label: string): string {
  return label.normalize("NFKC").replaceAll(/\s+/g, "").toLowerCase();
}

export const articleFeatureOutputSchema = articleFeatureSchema;

export interface FeatureInferenceRequest {
  messages: AiGatewayMessage[];
  schema: typeof articleFeatureOutputSchema;
  schemaName: "article_features";
  promptCacheKey: string;
  taskType: Extract<AiGatewayTaskType, "summary">;
  enableThinking: false;
}

export type FeatureInferenceRunner = (request: FeatureInferenceRequest) => Promise<unknown>;

const SYSTEM_PROMPT = `/no_think
你是服务于专业投资者的中国资本市场研报分析员。请从单篇研报中抽取可核验的结构化特征（节点与因果主张），重点判断其对权益和固收利率的影响。

证据边界：
1. 只能使用输入标题和正文，不得补充外部事实、常识性结论或未被原文支持的预测。
2. fact 必须是原文事实或原文明确观点的简短转述，不得写成自己的归纳。
3. author 只提取正文或标题明确出现的发布机构或研究业务团队，不需要精确到个人姓名。例：“国海固收颜子琦团队”输出“国海固收”，“华泰固收张继强团队”输出“华泰固收”；无法确认机构时输出空字符串，不得猜测。
4. title 必须逐字复制输入标题。

importance 评分（0-100 的整数）：
先分别打分再求和，只输出总分：影响范围 0-25、变化幅度与新颖性 0-25、证据确定性 0-20、定价时效与可交易性 0-20、影响持续性 0-10。
- 影响范围：单一个股约 5，单一行业约 10，单一大类资产约 16，跨资产或全国性宏观约 22，系统性影响 25。
- 变化幅度与新颖性：重复已知信息 0-5，边际变化 6-12，显著变化 13-19，制度或趋势拐点 20-25。
- 证据确定性：传闻或弱推断 0-4，机构主观判断 5-9，单一明确事实 10-14，多项数据或官方事实 15-20。
- 定价时效与可交易性：无明确交易含义 0-4，中长期线索 5-9，近期可验证 10-14，短期直接影响定价 15-20。
- 影响持续性：日内噪音 0-2，数日到数周 3-5，季度级 6-8，结构性 9-10。
校准锚点：例行复盘约 15-30，局部边际信息约 31-45，方向清晰但影响有限约 46-60，重要交易信号约 61-75，重大跨资产重定价约 76-90，90 以上仅限极少数系统性事件。不得因文章是研报就默认给 65、70、75；不要刻意取 5 的倍数，必须使用上述分项的实际总和。单一机构的主观判断不得仅因措辞强烈而获得高分。

节点规则：
5. 输出 1-10 个互不重复的 nodes，按市场影响的重要性降序。label 是 2-16 个字的无方向市场概念（不含涨跌升降），例如“DR007”“10年国债收益率”“降准”“银行股”，必须落到原文中的具体政策操作、数据变化、资金行为、行业线索或定价主题，读者只看 label 也应知道文章在讨论什么。禁止输出“市场、政策、经济、利率、债券、股票、风险、宏观基本面、外部约束、市场影响、政策预期、货币政策预期”等空泛词；若初步概括仍属于这类上位词，必须继续用原文事实收窄。例如将“货币政策预期”改为“降准降息观察期”“隔夜逆回购重启”或“DR001宽松区间”，具体选择取决于原文证据。
6. 合并同义词、上下位概念和同一因果链中的近义信号。例如“货币政策预期”和“降准降息概率”应合并并收窄为“降准降息预期”；只有事实依据、传导机制或资产影响彼此独立时才拆成多个 node。
7. fact 是原文事实或原文明确观点的简短转述，不写归纳。impact 必须是一至两句可直接用于投资判断的明确观点，写清主要受影响的资产或行业、方向以及关键机制或成立条件。这里的“方向”必须落到资产价格、收益率、利差、风险溢价或仓位的上升/下降；仅写“不确定性增加、方向纠结、波动加大、等待观察”不算方向。每条 impact 至少包含一个明确的价格方向或加减仓建议，不能先写空泛判断再补一句方向。优先使用“利多/利空、推高/压低、提振/压制、扩大/收窄、加仓/减仓、延长/缩短久期”等词。任何包含“影响/引导/改变定价逻辑”“引导走势”“影响整体走势”“影响风险偏好”“值得关注”“带来影响”“存在不确定性”等空泛分句的 impact 都不合格，即使同一句后半段有方向也必须删除空泛分句并整体重写。例如：“影响债市利率定价逻辑，引导长端利率走势”应改为“隔夜逆回购缓解税期资金压力，短期利多长端利率债并压低收益率”；“引导债市利率定价逻辑，限制利率过度下行空间”应改为“央行容忍约1.30%的DR001，资金利率进一步下行空间受限，短端利率债的宽松交易将降温”；“增加债市定价的不确定性，导致利率方向纠结”应改为“降准降息未释放增量信号，利率债缺乏进一步做多催化，短期宜缩短久期”；“影响科技板块整体走势及市场风险偏好”应改为“光通信权重企稳可提振科技板块风险偏好，若放量转跌则应降低成长股仓位”。若原文证据不足以形成明确观点，就不要输出该 node，而不是给出模糊 impact。相较其他市场优先分析权益和固收，但不强行覆盖两个市场。输出 JSON 前逐条复查 impact，发现任一空泛分句必须重写。
8. summary 仅用一句、目标 35-50 个汉字概括核心结论、最关键依据和首要市场影响，硬性不得超过 55 个汉字；删除背景铺陈、标题复述和次要细节。风格示例：“央行重启隔夜逆回购缓解税期压力，但降准降息仍处观察期，利率债短期缺乏明确方向。”输出 JSON 前计算字数，超过 55 字必须压缩重写。
9. 输出必须是一个合法 JSON 对象，不要输出 Markdown、代码围栏、注释或思考过程。

因果主张规则（claims）：
10. claim 只记录正文明确陈述的因果链接，最多 6 条，没有就输出空数组。不得自行推演或串联多步链条，一条 claim 只写相邻的一步。
11. cause 和 effect 必须逐字取自本文 nodes 的 label，所以出现在 claim 中的概念都要先成为 node。方向只写在 causeMove 和 effectMove：rise 上升、fall 下降。政策动作或事件本身用 causeMove=occur，effectMove 只能是 rise 或 fall。
12. 用户消息末尾若给出“近期已有节点”，同一概念必须沿用其中的写法作为 label，不得另起同义名称。
13. kind 取 policy 政策、macro 宏观数据、market 利率汇率或资产价格、sector 行业板块、event 事件。
14. basis=observed 仅当正文说明结果已经发生，预期、判断和推演一律用 expected。mechanism 写正文给出的传导机制或成立条件。`;

export async function extractArticleFeatures(
  runInference: FeatureInferenceRunner,
  title: string,
  markdown: string,
  recentLabels: string[] = [],
): Promise<ArticleFeatures> {
  const output = await runInference(buildFeatureInferenceRequest(title, markdown, recentLabels));
  return validateArticleFeatures(output, title);
}

/** Shared by ArticleWorkflow and the graph backfill: one extraction call with recent node labels. */
export async function extractFeaturesForArticle(
  env: Pick<Env, "DB" | "CLOUDFLARE_ACCOUNT_ID" | "AI_GATEWAY_ID" | "CF_AIG_TOKEN">,
  article: { id: string; title: string },
  markdown: string,
  asOf: Date = new Date(),
): Promise<ArticleFeatures> {
  const recentLabels = await loadRecentNodeLabels(env.DB, asOf);
  return await extractArticleFeatures(
    async (input) =>
      await generateAiGatewayObject(
        { accountId: env.CLOUDFLARE_ACCOUNT_ID, gatewayId: env.AI_GATEWAY_ID, token: env.CF_AIG_TOKEN },
        input.messages,
        input.schema,
        input.schemaName,
        {
          promptCacheKey: input.promptCacheKey,
          requestTimeoutMs: 120_000,
          taskType: input.taskType,
          metadata: {
            article_id: article.id,
            prompt_version: ARTICLE_FEATURE_PROMPT_VERSION,
            tags: `eastmoney,feature-extraction,model:${ARTICLE_FEATURE_MODEL}`,
          },
        },
      ),
    article.title,
    markdown,
    recentLabels,
  );
}

export function buildFeatureInferenceRequest(
  title: string,
  markdown: string,
  recentLabels: string[] = [],
): FeatureInferenceRequest {
  // Variable evidence stays at the end of the user message so the system prompt keeps its cache key.
  const vocabulary = recentLabels.length
    ? `\n\n近期已有节点：${recentLabels.join("、")}`
    : "";
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `输入标题：${title}\n\n输入正文：\n${markdown}${vocabulary}\n\n请严格遵循响应 JSON Schema 输出，不要增加字段。`,
      },
    ],
    schema: articleFeatureOutputSchema,
    schemaName: "article_features",
    promptCacheKey: `article-features:${ARTICLE_FEATURE_PROMPT_VERSION}`,
    taskType: "summary",
    enableThinking: false,
  };
}

export function validateArticleFeatures(value: unknown, expectedTitle: string): ArticleFeatures {
  const row = objectValue(value, "article features");
  requiredString(row.title, "title", 500);
  const author = optionalString(row.author, "author", 160);
  const summary = requiredString(row.summary, "summary", 600);
  const importance = row.importance;
  if (!Number.isInteger(importance) || (importance as number) < 0 || (importance as number) > 100) {
    throw new Error("importance must be an integer between 0 and 100");
  }
  if (!Array.isArray(row.nodes) || row.nodes.length < 1 || row.nodes.length > MAX_NODES) {
    throw new Error(`nodes must contain 1-${MAX_NODES} items`);
  }
  // Labels that normalize to the same key are one concept; keep the first, which ranks higher.
  const keys = new Set<string>();
  const nodes = row.nodes
    .map((item, index) => validateNode(item, index))
    .filter((node) => {
      const key = nodeKey(node.label);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
  return {
    title: expectedTitle,
    author,
    summary,
    importance: importance as number,
    nodes,
    claims: normalizeClaims(row.claims, keys),
  };
}

/** Invalid claims are dropped one by one; they never fail the article. */
export function normalizeClaims(value: unknown, nodeKeys: ReadonlySet<string>): ArticleClaim[] {
  if (!Array.isArray(value)) return [];
  const claims: ArticleClaim[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const claim = parseClaim(item, nodeKeys);
    if (!claim) continue;
    const key = `${nodeKey(claim.cause)}|${claim.causeMove}|${nodeKey(claim.effect)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
    if (claims.length === MAX_CLAIMS) break;
  }
  return claims;
}

function parseClaim(value: unknown, nodeKeys: ReadonlySet<string>): ArticleClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const cause = claimText(row.cause, 160);
  const effect = claimText(row.effect, 160);
  const mechanism = claimText(row.mechanism, 160);
  const causeMove = claimEnum(CAUSE_MOVES, row.causeMove);
  const effectMove = claimEnum(EFFECT_MOVES, row.effectMove);
  const basis = claimEnum(CLAIM_BASES, row.basis);
  if (!cause || !effect || !mechanism || !causeMove || !effectMove || !basis) return null;
  const causeKey = nodeKey(cause);
  const effectKey = nodeKey(effect);
  if (causeKey === effectKey || !nodeKeys.has(causeKey) || !nodeKeys.has(effectKey)) return null;
  return { cause, causeMove, effect, effectMove, basis, mechanism };
}

function claimText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function claimEnum<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Most frequent recent node labels, offered to the model so it reuses names. */
export async function loadRecentNodeLabels(database: D1Database, asOf: Date): Promise<string[]> {
  const since = new Date(asOf.getTime() - RECENT_LABEL_DAYS * 86_400_000).toISOString();
  const result = await database
    .prepare(`
      SELECT n.label
      FROM article_node n JOIN article a ON a.id = n.article_id
      WHERE julianday(a.published_at) >= julianday(?1) AND julianday(a.published_at) <= julianday(?2)
      GROUP BY n.label
      ORDER BY COUNT(*) DESC, n.label ASC
      LIMIT ?3
    `)
    .bind(since, asOf.toISOString(), RECENT_LABEL_LIMIT)
    .all<{ label: string }>();
  return (result.results ?? []).map((row) => row.label);
}

export function buildR2Metadata(
  features: ArticleFeatures,
  publishedAt: string,
): Record<string, string> {
  return {
    type: "研报",
    source: features.author,
    tags: features.nodes.map((node) => node.label).join(","),
    author: features.author,
    summary: features.summary,
    importance: String(features.importance),
    keywords: features.nodes.map((node) => node.label).join(","),
    published_at: new Date(publishedAt).toISOString(),
  };
}

export async function saveArticleFeatures(
  database: D1Database,
  articleId: string,
  features: ArticleFeatures,
  updatedAt: string,
): Promise<void> {
  const results = await database.batch(
    featureStatements(
      database,
      database
        .prepare(`
          UPDATE article
          SET author = ?, summary = ?, importance = ?, prompt_version = ?, updated_at = ?
          WHERE id = ?
        `)
        .bind(
          features.author,
          features.summary,
          features.importance,
          ARTICLE_FEATURE_PROMPT_VERSION,
          updatedAt,
          articleId,
        ),
      articleId,
      features,
    ),
  );
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new Error(`article not found while storing features: ${articleId}`);
  }
}

function featureStatements(
  database: D1Database,
  update: D1PreparedStatement,
  articleId: string,
  features: ArticleFeatures,
): D1PreparedStatement[] {
  return [
    update,
    database.prepare("DELETE FROM article_claim WHERE article_id = ?").bind(articleId),
    database.prepare("DELETE FROM article_node WHERE article_id = ?").bind(articleId),
    ...features.nodes.map((node, ordinal) =>
      database
        .prepare(`
          INSERT INTO article_node (article_id, ordinal, label, kind, fact, impact)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(articleId, ordinal, node.label, node.kind, node.fact, node.impact),
    ),
    ...features.claims.map((claim, ordinal) =>
      database
        .prepare(`
          INSERT INTO article_claim (
            article_id, ordinal, cause, cause_move, effect, effect_move, basis, mechanism
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          articleId,
          ordinal,
          claim.cause,
          claim.causeMove,
          claim.effect,
          claim.effectMove,
          claim.basis,
          claim.mechanism,
        ),
    ),
  ];
}

function validateNode(value: unknown, index: number): ArticleNode {
  const row = objectValue(value, `nodes[${index}]`);
  const kind = claimEnum(NODE_KINDS, row.kind);
  if (!kind) throw new Error(`nodes[${index}].kind is invalid`);
  return {
    label: requiredString(row.label, `nodes[${index}].label`, 16),
    kind,
    fact: requiredString(row.fact, `nodes[${index}].fact`, 400),
    impact: requiredString(row.impact, `nodes[${index}].impact`, 500),
  };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, name, maxLength);
}
