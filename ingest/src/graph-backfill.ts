import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { articleObjectKey } from "./article";
import {
  ARTICLE_FEATURE_PROMPT_VERSION,
  extractFeaturesForArticle,
  saveArticleFeatures,
} from "./feature-extraction";

export const BACKFILL_DEFAULT_FROM = "2026-07-01";
export const BACKFILL_MAX_LIMIT = 200;
const BACKFILL_CONCURRENCY = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BackfillParams {
  /** Shanghai calendar date, inclusive. */
  from?: string;
  /** Resume after this article id (the `lastId` of the previous run); runs go newest to oldest. */
  after?: string;
  limit?: number;
}

export interface BackfillSummary {
  from: string;
  listed: number;
  processed: number;
  missing: number;
  failed: number;
  /** Pass as `after` to continue; null when nothing was listed. */
  lastId: string | null;
}

interface PendingArticle {
  id: string;
  title: string;
  published_at: string;
}

type Outcome = "processed" | "missing" | "failed";

export function parseBackfillParams(params: BackfillParams): Required<Omit<BackfillParams, "after">> & { after: string } {
  const from = params.from ?? BACKFILL_DEFAULT_FROM;
  if (!DATE.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) {
    throw new NonRetryableError("backfill from must be a YYYY-MM-DD date");
  }
  const limit = params.limit ?? BACKFILL_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > BACKFILL_MAX_LIMIT) {
    throw new NonRetryableError(`backfill limit must be an integer between 1 and ${BACKFILL_MAX_LIMIT}`);
  }
  return { from, limit, after: params.after ?? "" };
}

export async function listPendingArticles(
  database: D1Database,
  params: { from: string; after: string; limit: number },
): Promise<PendingArticle[]> {
  const result = await database
    .prepare(`
      SELECT id, title, published_at
      FROM article
      WHERE summary IS NOT NULL
        AND date(published_at, '+8 hours') >= ?1
        AND (prompt_version IS NULL OR prompt_version != ?2)
        AND (?3 = '' OR julianday(published_at) < (SELECT julianday(published_at) FROM article WHERE id = ?3)
             OR (julianday(published_at) = (SELECT julianday(published_at) FROM article WHERE id = ?3) AND id < ?3))
      ORDER BY julianday(published_at) DESC, id DESC
      LIMIT ?4
    `)
    .bind(params.from, ARTICLE_FEATURE_PROMPT_VERSION, params.after, params.limit)
    .all<PendingArticle>();
  return result.results ?? [];
}

/**
 * Re-extracts nodes and claims for archived articles from their R2 Markdown, without
 * touching DM, policy links or the archive. Safe to repeat: finished articles carry the
 * current prompt version and are no longer listed.
 */
export class ArticleBackfillWorkflow extends WorkflowEntrypoint<Env, BackfillParams> {
  override async run(event: Readonly<WorkflowEvent<BackfillParams>>, step: WorkflowStep): Promise<BackfillSummary> {
    const params = parseBackfillParams(event.payload ?? {});
    const pending = await step.do(
      "list articles without graph data",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => await listPendingArticles(this.env.DB, params),
    );

    const summary: BackfillSummary = {
      from: params.from,
      listed: pending.length,
      processed: 0,
      missing: 0,
      failed: 0,
      lastId: pending.at(-1)?.id ?? null,
    };
    for (let index = 0; index < pending.length; index += BACKFILL_CONCURRENCY) {
      const outcomes = await Promise.all(
        pending.slice(index, index + BACKFILL_CONCURRENCY).map((article) => this.backfillOne(step, article)),
      );
      for (const outcome of outcomes) summary[outcome] += 1;
    }
    console.log(JSON.stringify({ event: "article_graph_backfill", ...summary }));
    return summary;
  }

  private async backfillOne(step: WorkflowStep, article: PendingArticle): Promise<Outcome> {
    try {
      return await step.do(
        `backfill article ${article.id}`,
        { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const object = await this.env.ARTICLE_BUCKET.get(
            articleObjectKey({ id: article.id, title: article.title, publishedAt: article.published_at }),
          );
          if (!object) return "missing";
          const features = await extractFeaturesForArticle(
            this.env,
            article,
            await object.text(),
            new Date(article.published_at),
          );
          await saveArticleFeatures(this.env.DB, article.id, features, new Date().toISOString());
          return "processed";
        },
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "article_graph_backfill_failed",
        articleId: article.id,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }));
      return "failed";
    }
  }
}
