import type { CommentarySummary } from "../commentary.ts";
import type {
  ArticleSearchResult,
  PolicyArticle,
  PolicyCategory,
  PolicyEvent,
  PolicyNews,
  PolicyNewsDetail,
  RelatedPolicySummary,
} from "$lib/policies";

export class PolicyRepositoryError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PolicyRepositoryError";
    this.status = status;
  }
}

interface PolicyRow {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  importance: PolicyEvent["importance"];
  departments_json: string;
  policy_date: string;
  first_news_at: string;
  last_news_at: string;
  updated_at: string;
}

interface NewsRow {
  sentiment_id: string;
  policy_id: string;
  news_id: string | null;
  title: string;
  published_at: string;
  link: string | null;
}

interface ArticleRow {
  policy_id: string;
  id: string;
  title: string;
  author: string | null;
  summary: string;
  published_at: string;
  link: string | null;
  association_method: "ai" | "manual";
}

interface CommentaryRow {
  id: string;
  policy_id: string;
  commentary_type: CommentarySummary["type"];
  event_name: string;
  sources: string;
  event_published_at: string;
  commentary_date: string;
  event_summary: string;
  commentary: string;
  recommendation: string;
  model: string | null;
  prompt_version: string | null;
  generated_at: string | null;
  edited: number;
  updated_at: string;
}

interface SearchRow {
  id: string;
  title: string;
  author: string | null;
  summary: string;
  published_at: string;
  link: string | null;
}

interface RelatedPolicyRow {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  policy_date: string;
}

interface PolicyNewsDetailRow {
  sentiment_id: string;
  news_id: string | null;
  title: string;
  published_at: string;
  content: string | null;
  link: string | null;
  policy_id: string;
  policy_title: string;
  policy_summary: string;
  policy_category: PolicyCategory;
  policy_date: string;
}

interface GenerationNewsRow {
  id: string;
  title: string;
  published_at: string;
  content: string;
}

export interface CommentaryGenerationContext {
  policy: Pick<
    PolicyEvent,
    "id" | "title" | "summary" | "category" | "departments" | "policyDate"
  >;
  news: GenerationNewsRow[];
  articles: Array<{
    id: string;
    title: string;
    author: string | null;
    publishedAt: string;
  }>;
}

export async function loadPolicyTimeline(
  database: Env["DB"],
  filters: { startDate?: string; endDate?: string; category?: PolicyCategory } = {},
): Promise<PolicyEvent[]> {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filters.startDate) {
    conditions.push("policy_date >= ?");
    bindings.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push("policy_date <= ?");
    bindings.push(filters.endDate);
  }
  if (filters.category) {
    conditions.push("category = ?");
    bindings.push(filters.category);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = database.prepare(`
    SELECT id, title, summary, category, importance, departments_json, policy_date,
           first_news_at, last_news_at, updated_at
    FROM policy_event
    ${where}
    ORDER BY policy_date DESC, last_news_at DESC, id DESC
    LIMIT 100
  `);
  const result = bindings.length > 0
    ? await statement.bind(...bindings).all<PolicyRow>()
    : await statement.all<PolicyRow>();
  const policyRows = (result.results ?? []) as PolicyRow[];
  if (policyRows.length === 0) return [];
  const policyIds = policyRows.map((row) => row.id);
  const placeholders = policyIds.map(() => "?").join(", ");
  const [newsResult, articleResult, commentaryResult] = await Promise.all([
    database.prepare(`
      SELECT sentiment_id, policy_id, news_id, title, published_at, link
      FROM policy_news
      WHERE policy_id IN (${placeholders}) AND aggregation_status = 'grouped'
      ORDER BY published_at ASC, sentiment_id ASC
    `).bind(...policyIds).all<NewsRow>(),
    database.prepare(`
      SELECT pa.policy_id, a.id, a.title, a.author, a.summary, a.published_at, a.link,
             pa.association_method
      FROM policy_article pa
      JOIN article a ON a.id = pa.article_id
      WHERE pa.policy_id IN (${placeholders}) AND pa.relation_status = 'linked'
      ORDER BY a.published_at DESC, a.id DESC
    `).bind(...policyIds).all<ArticleRow>(),
    database.prepare(`
      SELECT id, policy_id, commentary_type, event_name, sources,
             event_published_at, commentary_date, event_summary, commentary,
             recommendation, model, prompt_version, generated_at, edited, updated_at
      FROM commentary
      WHERE policy_id IN (${placeholders})
    `).bind(...policyIds).all<CommentaryRow>(),
  ]);
  const newsRows = (newsResult.results ?? []) as NewsRow[];
  const articleRows = (articleResult.results ?? []) as ArticleRow[];
  const commentaryRows = (commentaryResult.results ?? []) as CommentaryRow[];
  const newsByPolicy = groupBy(newsRows, (row) => row.policy_id);
  const articlesByPolicy = groupBy(articleRows, (row) => row.policy_id);
  const commentaryByPolicy = new Map(
    commentaryRows.map((row) => [row.policy_id, commentaryFromRow(row)]),
  );
  return policyRows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    importance: row.importance,
    departments: parseStringArray(row.departments_json, "政策发布部门"),
    policyDate: row.policy_date,
    firstNewsAt: row.first_news_at,
    lastNewsAt: row.last_news_at,
    updatedAt: row.updated_at,
    news: (newsByPolicy.get(row.id) ?? []).map(newsFromRow),
    articles: (articlesByPolicy.get(row.id) ?? []).map(articleFromRow),
    commentary: commentaryByPolicy.get(row.id) ?? null,
  }));
}

export async function searchPolicyArticles(
  database: Env["DB"],
  query: string,
  limit = 50,
): Promise<ArticleSearchResult[]> {
  const normalized = query.trim();
  const statement = normalized
    ? database.prepare(`
        SELECT id, title, author, summary, published_at, link
        FROM article
        WHERE summary IS NOT NULL
          AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
        ORDER BY published_at DESC, id DESC
        LIMIT ?
      `).bind(...Array(3).fill(`%${escapeLike(normalized)}%`), limit)
    : database.prepare(`
        SELECT id, title, author, summary, published_at, link
        FROM article
        WHERE summary IS NOT NULL
        ORDER BY published_at DESC, id DESC
        LIMIT ?
      `).bind(limit);
  const result = await statement.all<SearchRow>();
  const rows = (result.results ?? []) as SearchRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    summary: row.summary,
    publishedAt: row.published_at,
    link: row.link,
  }));
}

export async function loadResearchReportMetadata(
  database: Env["DB"],
  articleId: string,
): Promise<ArticleSearchResult & { policies: RelatedPolicySummary[] }> {
  const article = await database.prepare(`
    SELECT id, title, author, summary, published_at, link
    FROM article
    WHERE id = ? AND summary IS NOT NULL
  `).bind(articleId).first<SearchRow>();
  if (!article) throw new PolicyRepositoryError(404, "研报不存在");

  const policyResult = await database.prepare(`
    SELECT pe.id, pe.title, pe.summary, pe.category, pe.policy_date
    FROM policy_article pa
    JOIN policy_event pe ON pe.id = pa.policy_id
    WHERE pa.article_id = ? AND pa.relation_status = 'linked'
    ORDER BY pe.policy_date DESC, pe.id DESC
  `).bind(articleId).all<RelatedPolicyRow>();
  const policies = ((policyResult.results ?? []) as RelatedPolicyRow[]).map(relatedPolicyFromRow);
  return {
    id: article.id,
    title: article.title,
    author: article.author,
    summary: article.summary,
    publishedAt: article.published_at,
    link: article.link,
    policies,
  };
}

export async function loadPolicyNewsDetail(
  database: Env["DB"],
  sentimentId: string,
): Promise<PolicyNewsDetail> {
  const row = await database.prepare(`
    SELECT pn.sentiment_id, pn.news_id, pn.title, pn.published_at,
           pn.content, pn.link, pe.id AS policy_id, pe.title AS policy_title,
           pe.summary AS policy_summary, pe.category AS policy_category,
           pe.policy_date
    FROM policy_news pn
    JOIN policy_event pe ON pe.id = pn.policy_id
    WHERE pn.sentiment_id = ? AND pn.aggregation_status = 'grouped'
  `).bind(sentimentId).first<PolicyNewsDetailRow>();
  if (!row) throw new PolicyRepositoryError(404, "政策资讯不存在");
  if (!row.content?.trim()) {
    throw new PolicyRepositoryError(422, "政策资讯正文尚未完整入库");
  }
  return {
    id: row.sentiment_id,
    newsId: row.news_id,
    title: row.title,
    publishedAt: row.published_at,
    content: row.content,
    link: row.link,
    policy: {
      id: row.policy_id,
      title: row.policy_title,
      summary: row.policy_summary,
      category: row.policy_category,
      policyDate: row.policy_date,
    },
  };
}

export async function saveManualPolicyArticles(
  database: Env["DB"],
  policyId: string,
  articleIds: string[],
): Promise<void> {
  await requirePolicy(database, policyId);
  const uniqueIds = [...new Set(articleIds)];
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const found = await database.prepare(`
      SELECT id FROM article WHERE id IN (${placeholders})
    `).bind(...uniqueIds).all<{ id: string }>();
    if (found.results.length !== uniqueIds.length) {
      throw new PolicyRepositoryError(400, "关联研报中包含不存在的 article");
    }
  }
  const existing = await database.prepare(`
    SELECT article_id FROM policy_article
    WHERE policy_id = ? AND relation_status = 'linked'
  `).bind(policyId).all<{ article_id: string }>();
  const selected = new Set(uniqueIds);
  const now = new Date().toISOString();
  const statements: Array<ReturnType<Env["DB"]["prepare"]>> = [];
  const existingRows = (existing.results ?? []) as Array<{ article_id: string }>;
  for (const row of existingRows) {
    if (selected.has(row.article_id)) continue;
    statements.push(database.prepare(`
      UPDATE policy_article
      SET relation_status = 'excluded', association_method = 'manual',
          updated_at = ?
      WHERE policy_id = ? AND article_id = ?
    `).bind(now, policyId, row.article_id));
  }
  for (const articleId of uniqueIds) {
    statements.push(database.prepare(`
      INSERT INTO policy_article (
        policy_id, article_id, relation_status, association_method,
        created_at, updated_at
      ) VALUES (?, ?, 'linked', 'manual', ?, ?)
      ON CONFLICT(policy_id, article_id) DO UPDATE SET
        relation_status = 'linked', association_method = 'manual',
        updated_at = excluded.updated_at
    `).bind(policyId, articleId, now, now));
  }
  if (statements.length > 0) await database.batch(statements);
}

export async function loadCommentaryGenerationContext(
  database: Env["DB"],
  policyId: string,
): Promise<CommentaryGenerationContext> {
  const policy = await requirePolicy(database, policyId);
  const [news, articles] = await Promise.all([
    database.prepare(`
      SELECT sentiment_id AS id, title, published_at, content
      FROM policy_news
      WHERE policy_id = ? AND aggregation_status = 'grouped'
      ORDER BY published_at ASC, sentiment_id ASC
    `).bind(policyId).all<GenerationNewsRow>(),
    database.prepare(`
      SELECT a.id, a.title, a.author, a.published_at
      FROM policy_article pa
      JOIN article a ON a.id = pa.article_id
      WHERE pa.policy_id = ? AND pa.relation_status = 'linked'
      ORDER BY a.published_at ASC, a.id ASC
    `).bind(policyId).all<{
      id: string;
      title: string;
      author: string | null;
      published_at: string;
    }>(),
  ]);
  const newsRows = (news.results ?? []) as GenerationNewsRow[];
  const articleRows = (articles.results ?? []) as Array<{
    id: string;
    title: string;
    author: string | null;
    published_at: string;
  }>;
  if (newsRows.length === 0 || newsRows.some((item) => !item.content)) {
    throw new PolicyRepositoryError(422, "政策资讯正文尚未完整入库");
  }
  return {
    policy: {
      id: policy.id,
      title: policy.title,
      summary: policy.summary,
      category: policy.category,
      departments: parseStringArray(policy.departments_json, "政策发布部门"),
      policyDate: policy.policy_date,
    },
    news: newsRows,
    articles: articleRows.map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      publishedAt: row.published_at,
    })),
  };
}

async function requirePolicy(database: Env["DB"], policyId: string): Promise<PolicyRow> {
  const policy = await database.prepare(`
    SELECT id, title, summary, category, departments_json, policy_date,
           first_news_at, last_news_at, updated_at
    FROM policy_event WHERE id = ?
  `).bind(policyId).first<PolicyRow>();
  if (!policy) throw new PolicyRepositoryError(404, "政策记录不存在");
  return policy;
}

function newsFromRow(row: NewsRow): PolicyNews {
  return {
    id: row.sentiment_id,
    newsId: row.news_id,
    title: row.title,
    publishedAt: row.published_at,
    link: row.link,
  };
}

function articleFromRow(row: ArticleRow): PolicyArticle {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    summary: row.summary,
    publishedAt: row.published_at,
    link: row.link,
    associationMethod: row.association_method,
  };
}

function commentaryFromRow(row: CommentaryRow): CommentarySummary {
  return {
    id: row.id,
    policyId: row.policy_id,
    type: row.commentary_type,
    eventName: row.event_name,
    sources: row.sources,
    eventPublishedAt: row.event_published_at,
    commentaryDate: row.commentary_date,
    eventSummary: row.event_summary,
    commentary: row.commentary,
    recommendation: row.recommendation,
    model: row.model,
    promptVersion: row.prompt_version,
    generatedAt: row.generated_at,
    edited: row.edited === 1,
    updatedAt: row.updated_at,
  };
}

function relatedPolicyFromRow(row: RelatedPolicyRow): RelatedPolicySummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    policyDate: row.policy_date,
  };
}

function parseStringArray(raw: string, label: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value;
    }
  } catch {
    // Fall through to the explicit storage error.
  }
  throw new PolicyRepositoryError(500, `${label}数据无效`);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(key(row)) ?? [];
    group.push(row);
    result.set(key(row), group);
  }
  return result;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
