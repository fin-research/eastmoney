/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/1016_policy_article_decisions.sql?raw";
import {
  D1PolicyAssociationRepository, generateArticlePolicyMatches, generatePolicyArticleMatches,
  type ExistingPolicy, type PolicyArticleEvidence,
} from "../src/policy";

const credentials = { accountId: "account", gatewayId: "default", token: "token" };
const policy: ExistingPolicy = {
  id: "policy-1", title: "房地产信贷政策", summary: "明确调整房地产信贷政策。",
  category: "real_estate", importance: "related", departments: ["中国人民银行"],
  policyDate: "2026-08-28", firstNewsAt: "2026-08-28T08:00:00Z", lastNewsAt: "2026-08-28T08:00:00Z",
  newsTitles: ["关于调整房地产信贷政策的通知"],
};
const article: PolicyArticleEvidence = {
  id: "article-1", title: "房地产信贷政策解读", summary: "分析政策对融资的影响。",
  author: "测试机构", publishedAt: "2026-08-29T09:00:00+08:00",
  keywords: [{ topic: "信贷调整", fact: "调整信贷政策", interpretation: "融资条件改善", impact: "利多地产债" }],
};

function output(value: unknown): Response {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
}

function model(related = true) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.input[0].content);
    const candidates = input.policies ?? input.articles;
    return output({ decisions: candidates.map((candidate: { id: string }) => ({ candidateId: candidate.id, related })) });
  });
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS policy_event (id TEXT PRIMARY KEY)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS article (id TEXT PRIMARY KEY)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS policy_article (policy_id TEXT NOT NULL, article_id TEXT NOT NULL, relation_status TEXT NOT NULL, association_method TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(policy_id, article_id), FOREIGN KEY(policy_id) REFERENCES policy_event(id) ON DELETE CASCADE, FOREIGN KEY(article_id) REFERENCES article(id) ON DELETE CASCADE)"),
  ]);
  for (const sql of migration.split(";").filter(sql => sql.trim())) await env.DB.prepare(sql).run();
  // Migration is safe to replay against the shared database.
  for (const sql of migration.split(";").filter(sql => sql.trim())) await env.DB.prepare(sql).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM policy_article_decision"),
    env.DB.prepare("DELETE FROM policy_article"),
    env.DB.prepare("DELETE FROM policy_event"),
    env.DB.prepare("DELETE FROM article"),
    env.DB.prepare("INSERT INTO policy_event VALUES ('policy-1'), ('policy-2')"),
    env.DB.prepare("INSERT INTO article VALUES ('article-1'), ('article-2')"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("persistent association decisions", () => {
  it.each([true, false])("reuses %s decisions in both directions", async related => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    const fetcher = model(related);
    const expected = related ? [{ policyId: policy.id, articleId: article.id }] : [];
    expect(await generateArticlePolicyMatches(credentials, article, [policy], fetcher, repository)).toEqual(expected);
    expect(await generatePolicyArticleMatches(credentials, policy, [article], fetcher, repository)).toEqual(expected);
    expect(await generateArticlePolicyMatches(credentials, article, [policy], fetcher, repository)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT related FROM policy_article_decision").first("related")).toBe(Number(related));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article").first("n")).toBe(Number(related));
  });

  it("ignores collection timestamps, invalidates changed evidence and stale fingerprints, and sends only misses", async () => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    const fetcher = model();
    await generateArticlePolicyMatches(credentials, article, [policy], fetcher, repository);
    const retimed = { ...policy, firstNewsAt: "2026-09-01T00:00:00Z", lastNewsAt: "2026-09-02T00:00:00Z" };
    await generatePolicyArticleMatches(credentials, retimed, [article], fetcher, repository);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const changed = { ...policy, newsTitles: [...policy.newsTitles, "新增配套政策文件"] };
    await generatePolicyArticleMatches(credentials, changed, [article], fetcher, repository);
    const updatedArticle = { ...article, keywords: [{ ...article.keywords[0]!, fact: "政策事实已更新" }] };
    await generateArticlePolicyMatches(credentials, updatedArticle, [changed], fetcher, repository);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await env.DB.prepare("UPDATE policy_article_decision SET input_hash = 'previous-prompt-version'").run();
    await generateArticlePolicyMatches(credentials, updatedArticle, [changed], fetcher, repository);
    await generateArticlePolicyMatches(credentials, updatedArticle, [changed, { ...policy, id: "policy-2" }], fetcher, repository);
    const request = JSON.parse(String(fetcher.mock.calls[4]![1]!.body));
    expect(JSON.parse(request.input[0].content).policies.map((item: { id: string }) => item.id)).toEqual(["policy-2"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each(["linked", "excluded"])("respects manual %s decisions even if inserted during inference", async status => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    const fetcher = vi.fn<typeof fetch>(async () => {
      await env.DB.prepare("INSERT INTO policy_article VALUES (?, ?, ?, 'manual', 'now', 'now')")
        .bind(policy.id, article.id, status).run();
      return output({ decisions: [{ candidateId: policy.id, related: status !== "linked" }] });
    });
    await generateArticlePolicyMatches(credentials, article, [policy], fetcher, repository);
    expect(await env.DB.prepare("SELECT relation_status FROM policy_article").first("relation_status")).toBe(status);
    const result = await generatePolicyArticleMatches(credentials, policy, [article], fetcher, repository);
    expect(result).toHaveLength(status === "linked" ? 1 : 0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains completed policy decisions after another policy fails", async () => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    const fetcher = model();
    await generatePolicyArticleMatches(credentials, policy, [article], fetcher, repository);
    const failure = vi.fn<typeof fetch>(async () => new Response("invalid request", { status: 400 }));
    const other = { ...policy, id: "policy-2" };
    await expect(generatePolicyArticleMatches(credentials, other, [article], failure, repository)).rejects.toThrow();
    await generatePolicyArticleMatches(credentials, policy, [article], fetcher, repository);
    await generatePolicyArticleMatches(credentials, other, [article], fetcher, repository);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rolls back decisions when the associated relation write fails", async () => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    await env.DB.prepare("CREATE TRIGGER fail_relation BEFORE INSERT ON policy_article BEGIN SELECT RAISE(ABORT, 'test relation failure'); END").run();
    await expect(generateArticlePolicyMatches(credentials, article, [policy], model(), repository)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article_decision").first("n")).toBe(0);
    await env.DB.prepare("DROP TRIGGER fail_relation").run();
  });

  it("preserves historical AI links on a later negative decision", async () => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    await generateArticlePolicyMatches(credentials, article, [policy], model(), repository);
    await generateArticlePolicyMatches(credentials, { ...article, summary: "更新后的结论" }, [policy], model(false), repository);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT related FROM policy_article_decision").first("related")).toBe(0);
  });

  it("handles 100 candidates within the D1 binding limit and cascades deleted parents", async () => {
    const policies = Array.from({ length: 100 }, (_, index) => ({ ...policy, id: `candidate-${index}` }));
    await env.DB.batch(policies.map(item => env.DB.prepare("INSERT INTO policy_event VALUES (?)").bind(item.id)));
    const repository = new D1PolicyAssociationRepository(env.DB), fetcher = model(false);
    await generateArticlePolicyMatches(credentials, article, policies, fetcher, repository);
    await generateArticlePolicyMatches(credentials, article, policies, fetcher, repository);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await env.DB.prepare("DELETE FROM policy_event WHERE id = ?").bind(policies[0]!.id).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article_decision").first("n")).toBe(99);
    await env.DB.prepare("DELETE FROM article WHERE id = ?").bind(article.id).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article_decision").first("n")).toBe(0);
  });
});

describe("association response validation", () => {
  it.each([
    { name: "missing candidate", decisions: [] },
    { name: "duplicate candidate", decisions: [{ candidateId: "policy-1", related: true }, { candidateId: "policy-1", related: false }] },
    { name: "unknown candidate", decisions: [{ candidateId: "other", related: true }] },
  ])("rejects and retries $name without caching it", async ({ decisions }) => {
    const repository = new D1PolicyAssociationRepository(env.DB);
    const fetcher = vi.fn<typeof fetch>(async () => output({ decisions }));
    await expect(generateArticlePolicyMatches(credentials, article, [policy], fetcher, repository)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM policy_article_decision").first("n")).toBe(0);
  });
});
