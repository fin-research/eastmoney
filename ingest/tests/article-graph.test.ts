/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import migration from "../migrations/1022_create_article_graph.sql?raw";
import { articleObjectKey } from "../src/article";
import {
  ARTICLE_FEATURE_PROMPT_VERSION,
  loadRecentNodeLabels,
  saveArticleFeatures,
  type ArticleClaim,
  type ArticleFeatures,
} from "../src/feature-extraction";
import { listPendingArticles, parseBackfillParams } from "../src/graph-backfill";

const claim: ArticleClaim = {
  cause: "降准",
  causeMove: "occur",
  effect: "DR007",
  effectMove: "fall",
  basis: "observed",
  mechanism: "流动性投放压低资金利率。",
};

function features(claims: ArticleClaim[], labels = ["降准", "DR007", "银行股"]): ArticleFeatures {
  return {
    title: "标题",
    author: "机构",
    summary: "摘要",
    importance: 60,
    nodes: labels.map((label) => ({ label, kind: "market", fact: "事实", impact: "利多利率债" })),
    claims,
  };
}

async function insertArticle(id: string, publishedAt: string, summary: string | null = "摘要", version: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO article (id, title, published_at, created_at, updated_at, summary, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, `标题${id}`, publishedAt, publishedAt, publishedAt, summary, version).run();
}

beforeEach(async () => {
  await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  await env.DB.batch([
    env.DB.prepare("DROP TABLE IF EXISTS article_claim"),
    env.DB.prepare("DROP TABLE IF EXISTS article_node"),
    env.DB.prepare("DROP TABLE IF EXISTS article"),
    env.DB.prepare(`CREATE TABLE article (
      id TEXT PRIMARY KEY, news_id TEXT, title TEXT NOT NULL, published_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, link TEXT, author TEXT, summary TEXT,
      importance INTEGER, prompt_version TEXT
    ) WITHOUT ROWID`),
  ]);
  await env.DB.exec(migration.replaceAll(/\s*\n\s*/g, " "));
});

describe("article graph rows in D1", () => {
  it("replaces nodes and claims atomically so a rerun is idempotent", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");

    await saveArticleFeatures(env.DB, "a1", features([claim, { ...claim, effect: "银行股" }]), "2026-11-03T02:00:00Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T03:00:00Z");

    const claims = await env.DB.prepare("SELECT ordinal, cause, effect, basis FROM article_claim WHERE article_id = 'a1'").all();
    expect(claims.results).toEqual([{ ordinal: 0, cause: "降准", effect: "DR007", basis: "observed" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article_node").first("n")).toBe(3);
    expect(
      await env.DB.prepare("SELECT prompt_version FROM article WHERE id = 'a1'").first("prompt_version"),
    ).toBe(ARTICLE_FEATURE_PROMPT_VERSION);
  });

  it("removes stale claims when a rerun finds none", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");
    await saveArticleFeatures(env.DB, "a1", features([]), "2026-11-03T03:00:00Z");

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article_claim").first("n")).toBe(0);
  });

  it("cascades nodes and claims when the article is deleted", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");
    await env.DB.prepare("DELETE FROM article WHERE id = 'a1'").run();

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article_claim").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article_node").first("n")).toBe(0);
  });

  it("rejects a claim the schema constraints do not allow and keeps the old rows", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");

    await expect(
      saveArticleFeatures(env.DB, "a1", features([{ ...claim, effectMove: "occur" as never }]), "2026-11-03T03:00:00Z"),
    ).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article_claim").first("n")).toBe(1);
  });

  it("ranks recent node labels by frequency and ignores old articles", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await insertArticle("a2", "2026-11-02T01:00:00.000Z");
    await insertArticle("old", "2026-09-01T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([], ["DR007", "降准"]), "2026-11-03T02:00:00Z");
    await saveArticleFeatures(env.DB, "a2", features([], ["DR007", "降息"]), "2026-11-03T02:00:00Z");
    await saveArticleFeatures(env.DB, "old", features([], ["过期节点"]), "2026-09-01T02:00:00Z");

    const labels = await loadRecentNodeLabels(env.DB, new Date("2026-11-04T00:00:00Z"));

    expect(labels[0]).toBe("DR007");
    // As of a2's day, a1 is still in the future.
    expect(await loadRecentNodeLabels(env.DB, new Date("2026-11-02T02:00:00Z"))).not.toContain("降准");
    expect(labels).toEqual(expect.arrayContaining(["降准", "降息"]));
    expect(labels).not.toContain("过期节点");
  });
});

describe("graph backfill", () => {
  it("lists only featured articles from the Shanghai start date that lack the current version", async () => {
    await insertArticle("a1", "2026-06-30T15:59:59Z"); // 06-30 23:59 Shanghai: too early
    await insertArticle("a2", "2026-06-30T16:00:00Z"); // 07-01 00:00 Shanghai
    await insertArticle("a3", "2026-10-01T10:00:00+08:00", "摘要", "v5-responses-provider-fallback");
    await insertArticle("a4", "2026-10-02T01:00:00Z", "摘要", ARTICLE_FEATURE_PROMPT_VERSION);
    await insertArticle("a5", "2026-10-03T01:00:00Z", null);
    await insertArticle("a6", "2026-10-04T01:00:00Z");

    const params = { from: "2026-07-01", after: "", limit: 10 };
    // Newest first: a6 (10-04), a3 (10-01 Shanghai), a2 (07-01).
    expect((await listPendingArticles(env.DB, params)).map((row) => row.id)).toEqual(["a6", "a3", "a2"]);
    expect((await listPendingArticles(env.DB, { ...params, after: "a6", limit: 1 })).map((row) => row.id)).toEqual(["a3"]);
    expect((await listPendingArticles(env.DB, { ...params, after: "a3" })).map((row) => row.id)).toEqual(["a2"]);
  });

  it("validates the trigger payload", () => {
    expect(parseBackfillParams({})).toEqual({ from: "2026-07-01", limit: 200, after: "" });
    expect(() => parseBackfillParams({ from: "2026/07/01" })).toThrow("from");
    expect(() => parseBackfillParams({ limit: 201 })).toThrow("limit");
    expect(() => parseBackfillParams({ limit: 0 })).toThrow("limit");
  });

  it("skips articles whose archive is missing and reports the outcome", async () => {
    await insertArticle("b1", "2026-10-01T01:00:00Z");
    await insertArticle("b2", "2026-10-02T01:00:00Z");
    await env.DB.prepare("UPDATE article SET prompt_version = ? WHERE id = 'b2'").bind("old").run();
    const instance = await introspectWorkflowInstance(env.ARTICLE_BACKFILL_WORKFLOW, "backfill-missing");
    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult({ name: "backfill article b2" }, "processed");
      });
      await env.ARTICLE_BACKFILL_WORKFLOW.create({ id: "backfill-missing", params: { from: "2026-07-01" } });
      await instance.waitForStatus("complete");

      const summary = (await (await env.ARTICLE_BACKFILL_WORKFLOW.get("backfill-missing")).status()).output;
      expect(summary).toEqual({ from: "2026-07-01", listed: 2, processed: 1, missing: 1, failed: 0, lastId: "b1" });
      expect(articleObjectKey({ id: "b1", title: "标题b1", publishedAt: "2026-10-01T01:00:00Z" })).toBe("report/2026-10-01/标题b1.md");
    } finally {
      await instance.dispose();
    }
  });
});
