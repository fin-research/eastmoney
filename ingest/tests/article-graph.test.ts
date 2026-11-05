/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import migration from "../migrations/1022_create_node_claim.sql?raw";
import {
  ARTICLE_FEATURE_PROMPT_VERSION,
  loadRecentNodeLabels,
  saveArticleFeatures,
  type ArticleClaim,
  type ArticleFeatures,
} from "../src/feature-extraction";
import { graphReplaceStatements } from "../src/feature-sql";

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
    env.DB.prepare("DROP TABLE IF EXISTS claim"),
    env.DB.prepare("DROP TABLE IF EXISTS node"),
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

    const claims = await env.DB.prepare("SELECT ordinal, cause, effect, basis FROM claim WHERE article_id = 'a1'").all();
    expect(claims.results).toEqual([{ ordinal: 0, cause: "降准", effect: "DR007", basis: "observed" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM node").first("n")).toBe(3);
    expect(
      await env.DB.prepare("SELECT prompt_version FROM article WHERE id = 'a1'").first("prompt_version"),
    ).toBe(ARTICLE_FEATURE_PROMPT_VERSION);
  });

  it("removes stale claims when a rerun finds none", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");
    await saveArticleFeatures(env.DB, "a1", features([]), "2026-11-03T03:00:00Z");

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claim").first("n")).toBe(0);
  });

  it("cascades nodes and claims when the article is deleted", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");
    await env.DB.prepare("DELETE FROM article WHERE id = 'a1'").run();

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claim").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM node").first("n")).toBe(0);
  });

  it("rejects a claim the schema constraints do not allow and keeps the old rows", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");

    await expect(
      saveArticleFeatures(env.DB, "a1", features([{ ...claim, effectMove: "occur" as never }]), "2026-11-03T03:00:00Z"),
    ).rejects.toThrow();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claim").first("n")).toBe(1);
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

describe("backfill SQL", () => {
  it("replaces the rows and stamps the version last, surviving quotes and newlines", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z", "原摘要", "v5");
    await saveArticleFeatures(env.DB, "a1", features([claim]), "2026-11-03T02:00:00Z");
    const next = features([{ ...claim, mechanism: "含'单引号'和\n换行" }], ["降准", "DR007"]);
    next.nodes[0]!.fact = "O'Brien 说“降准”";

    const statements = graphReplaceStatements("a1", next, "v9", "2026-11-04T00:00:00Z");
    expect(statements.at(-1)).toContain("UPDATE article");
    for (const statement of statements) await env.DB.prepare(statement).run();

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM node").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT fact FROM node WHERE ordinal = 0").first("fact")).toBe("O'Brien 说“降准”");
    expect(await env.DB.prepare("SELECT mechanism FROM claim").first("mechanism")).toBe("含'单引号'和\n换行");
    const row = await env.DB.prepare("SELECT summary, prompt_version FROM article WHERE id = 'a1'").first();
    expect(row).toEqual({ summary: "摘要", prompt_version: "v9" });
  });

  it("escapes a statement injection attempt as plain text", async () => {
    await insertArticle("a1", "2026-11-03T01:00:00.000Z");
    const hostile = features([], ["x'); DROP TABLE article; --", "DR007"]);
    for (const statement of graphReplaceStatements("a1", hostile, "v9", "2026-11-04T00:00:00Z")) {
      await env.DB.prepare(statement).run();
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM article").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT label FROM node WHERE ordinal = 0").first("label")).toBe("x'); DROP TABLE article; --");
  });
});
