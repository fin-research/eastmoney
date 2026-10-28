import { commentaryDraftSchema } from "../src/lib/commentary.ts";
import { createCommentary, updateCommentary, getCommentary } from "../src/lib/server/commentary-repository.ts";
import { commentaryDatabase } from "./helpers/commentary-database.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  articleAssociationUpdateSchema,
  policyCategoryLabels,
  policyImportanceLabels,
  policyImportanceSchema,
} from "../src/lib/policies.ts";
import { parseResearchContent } from "../src/lib/report-content.ts";
import { fetchDataNewsDetail } from "../src/lib/server/data-news.ts";
import {
  stripCommentarySourceLinks,
} from "../src/lib/commentary-output.ts";
import {
  loadResearchReportMetadata,
  loadPolicyNewsDetail,
  loadPolicyTimeline,
  loadCommentaryGenerationContext,
} from "../src/lib/server/policy-repository.ts";

test("政策点评标准化字段通过运行时 Schema 校验", () => {
  const parsed = commentaryDraftSchema.parse({type:"policy_tracking",
    eventName: "房地产信贷管理新政",
    sources: "中国人民银行、国家金融监督管理总局",
    eventPublishedAt: "2026-09-01",
    commentaryDate: "2026-09-01",
    eventSummary: "房地产信贷管理制度完成系统性调整，贷款品种、期限与开发融资规则同步更新。",
    commentary: "1. 信贷管理框架系统调整\n政策从个人住房贷款和开发贷款两端同步完善规则。",
    recommendation: "建议结合政策落地和地产信用利差变化，动态评估相关主体融资窗口。",
  });

  assert.equal(parsed.eventPublishedAt, "2026-09-01");
  assert.throws(
    () => commentaryDraftSchema.parse({type:"policy_tracking", ...parsed, eventName: "" }),
    /too small/i,
  );
  assert.deepEqual(articleAssociationUpdateSchema.parse({ articleIds: ["A1", "A2"] }), {
    articleIds: ["A1", "A2"],
  });
  assert.equal(policyCategoryLabels.real_estate, "房地产");
  assert.equal(policyImportanceSchema.parse("important"), "important");
  assert.equal(policyImportanceLabels.related, "关联");
});

test("点评正文清理仍支持旧稿链接", () => {
  assert.equal(stripCommentarySourceLinks("详见[政策原文](https://example.com/policy)及 https://example.com/review。结论不变。"), "详见政策原文及。结论不变。");
});

test("政策时间轴一次装配政策资讯、自动研报关系与一对一点评", async () => {
  const database = fakePolicyDatabase();
  const policies = await loadPolicyTimeline(database);

  assert.equal(policies.length, 1);
  assert.equal(policies[0].importance, "related");
  assert.deepEqual(policies[0].departments, ["中国人民银行", "国家金融监督管理总局"]);
  assert.equal(policies[0].news.length, 2);
  assert.equal(policies[0].articles[0].associationMethod, "ai");
  assert.equal(policies[0].articles[0].summary, "研报摘要");
  assert.equal(policies[0].commentary.type, "policy_tracking");
});

test("政策页面展示重要性并使用隔离的时间轴类名", async () => {
  const [page, migration, relationMigration, importanceMigration] = await Promise.all([
    readFile(new URL("../src/lib/pages/PolicyTrackingPage.svelte", import.meta.url), "utf8"),
    readFile(new URL("../migrations/1004_create_policy_tracking.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/1005_remove_policy_article_explanations.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/1014_add_policy_importance.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /\/trading-research\/tracking-commentary/);
  assert.doesNotMatch(page, /generateCommentary|commentaryDraft/);
  assert.doesNotMatch(page, /请先关联至少一篇研报/);
  assert.match(page, /撰写点评/);
  assert.match(page, /\.policy-timeline \{ display: grid; gap: 2rem;/);
  assert.match(page, /\.policy-timeline-item \{ display: grid; grid-template-columns: 126px minmax\(0, 1fr\); gap: 2rem;/);
  assert.doesNotMatch(page, /class="timeline(?:-item)?"/);
  assert.match(page, /\.timeline-date \{[^}]*display: flex; align-items: flex-start; justify-content: flex-end;/);
  assert.match(page, /importance-chip--\$\{policy\.importance\}/);
  assert.match(page, /policyImportanceLabels\[policy\.importance\]/);
  assert.match(page, /\.importance-chip--important \{[^}]*color: #b42318;/);
  assert.match(page, /\.importance-chip--related \{[^}]*color: #175cd3;/);
  assert.match(page, /\.importance-chip--general \{[^}]*color: #475467;/);
  assert.match(page, /<small>\{article\.summary\}<\/small>/);
  assert.doesNotMatch(page, /article\.confidence|article\.rationale|ai-badge/);
  assert.match(page, />调整关联</);
  assert.doesNotMatch(page, /\/api\/policies\/aggregate/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS policy_event/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS policy_news/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS policy_article/);
  assert.match(migration, /association_method IN \('ai', 'manual'\)/);
  assert.match(migration, /policy_id TEXT UNIQUE/);
  assert.match(relationMigration, /CREATE TABLE policy_article_next/);
  assert.doesNotMatch(relationMigration, /confidence|rationale/);
  assert.match(importanceMigration, /ADD COLUMN importance TEXT NOT NULL DEFAULT 'general'/);
  assert.match(importanceMigration, /'important', 'related', 'general'/);
});

test("无关联研报时仍可装配政策点评生成上下文", async () => {
  const context = await loadCommentaryGenerationContext(
    fakeCommentaryGenerationDatabase(),
    "P1",
  );

  assert.equal(context.news.length, 1);
  assert.deepEqual(context.articles, []);
});

test("政策资讯、研报与点评使用独立深链并从政策页面进入", async () => {
  const [policyPage, newsPage, articlePage, commentaryPage] = await Promise.all([
    readFile(new URL("../src/lib/pages/PolicyTrackingPage.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/news/[id]/+page.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/articles/[id]/+page.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/commentaries/[id]/+page.svelte", import.meta.url), "utf8"),
  ]);

  assert.match(policyPage, /\/news\/\$\{encodeURIComponent\(item\.id\)\}/);
  assert.match(policyPage, /\/articles\/\$\{encodeURIComponent\(article\.id\)\}/);
  assert.match(policyPage, /tracking-commentary\?id=\$\{encodeURIComponent\(policy\.commentary\.id\)\}/);
  assert.match(newsPage, /\/api\/news\/\$\{encodeURIComponent\(data\.id\)\}/);
  assert.match(newsPage, /DM 原文/);
  assert.match(newsPage, /查看政策原文/);
  assert.match(articlePage, /\/api\/articles\/\$\{encodeURIComponent\(data\.id\)\}/);
  assert.match(articlePage, /研报正文/);
  assert.doesNotMatch(articlePage, /:global\(\.report-content\)/);
  assert.match(articlePage, /research-report-content/);
  assert.match(commentaryPage, /\/api\/commentaries\/\$\{encodeURIComponent\(data\.id\)\}/);
  assert.match(commentaryPage, /查看对应政策/);
});

test("研报正文以纯文本块安全呈现标题、列表和段落", () => {
  const blocks = parseResearchContent("## 核心结论\n\n1. 第一项\n2、第二项\n\n正文第一行\n正文第二行");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 2, text: "核心结论" },
    { kind: "list", ordered: true, items: ["第一项", "第二项"] },
    { kind: "paragraph", text: "正文第一行\n正文第二行" },
  ]);
});

test("研报详情复用 DATA Service Binding 并只读取正文和原文链接", async () => {
  let requestUrl = "";
  const detail = await fetchDataNewsDetail({
    DATA_API_BASE_URL: "https://eastmoney.hasbai.xyz/data",
    DATA: {
      async fetch(request) {
        requestUrl = request.url;
        return Response.json({ content: "研报正文", link: "https://example.com/report" });
      },
    },
  }, "A1");

  assert.equal(detail.content, "研报正文");
  assert.equal(detail.link, "https://example.com/report");
  assert.equal(requestUrl, "https://eastmoney.hasbai.xyz/data/news/A1?fields=content,link");
});

test("研报和点评详情仓储返回对应政策上下文", async () => {
  const report = await loadResearchReportMetadata(fakeDetailDatabase(), "A1");
  const {db,sqlite}=commentaryDatabase();
  sqlite.exec("INSERT INTO policy_event VALUES('P1','政策','摘要','real_estate','[]','2026-09-01','first','last','created','updated')");
  const created=await createCommentary(db,{policyId:'P1',type:'policy_tracking',eventName:'测试政策点评',sources:'来源',eventPublishedAt:'2026-09-01',commentaryDate:'2026-09-01',eventSummary:'摘要',commentary:'正文',recommendation:'建议'});
  const commentary = await getCommentary(db,created.id);
  sqlite.close();

  assert.equal(report.title, "房地产新政点评");
  assert.deepEqual(report.policies.map((policy) => policy.id), ["P1"]);
  assert.equal(commentary.id,created.id);
  assert.equal(commentary.policy.category, "real_estate");
});

test("统一新闻资讯详情返回 DM 原文、政策原文链接和关联政策", async () => {
  const detail = await loadPolicyNewsDetail(fakePolicyNewsDetailDatabase(), "N1");

  assert.equal(detail.title, "房地产信贷管理新政发布");
  assert.equal(detail.content, "DM 政策资讯原文");
  assert.equal(detail.link, "https://example.com/policy");
  assert.equal(detail.policy.id, "P1");
});

test("AI 点评保存时模型、Prompt 版本和生成时间绑定到正确列", async () => {
  const {db,sqlite}=commentaryDatabase();
  try {
    const draft={type:'current_affairs',eventName:'标准点评',sources:'来源',eventPublishedAt:'2026-09-01',commentaryDate:'2026-09-01',eventSummary:'摘要',commentary:'正文',recommendation:'建议',policyId:null};
    const initial=await createCommentary(db,draft);
    await updateCommentary(db,initial.id,draft,initial.updatedAt,{model:'test-model',promptVersion:'commentary-v1',evidence:[],search:{startDate:'2026-09-01',endDate:'2026-09-01',query:'标准点评'}});
    const row=sqlite.prepare('SELECT model,prompt_version,generated_at,updated_at FROM commentary WHERE id=?').get(initial.id);
    assert.equal(row.model,'test-model');assert.equal(row.prompt_version,'commentary-v1');assert.equal(row.generated_at,row.updated_at);
  }finally{sqlite.close();}

});

function fakePolicyDatabase() {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async all() {
          if (/FROM policy_event/.test(sql)) {
            return { results: [{
              id: "P1",
              title: "房地产信贷管理新政",
              summary: "政策摘要",
              category: "real_estate",
              importance: "related",
              departments_json: JSON.stringify(["中国人民银行", "国家金融监督管理总局"]),
              policy_date: "2026-09-01",
              first_news_at: "2026-09-01T19:00:00+08:00",
              last_news_at: "2026-09-01T19:25:00+08:00",
              updated_at: "2026-09-01T11:30:00Z",
            }] };
          }
          if (/FROM policy_news/.test(sql)) {
            return { results: [
              { sentiment_id: "N1", policy_id: "P1", news_id: null, title: "新政发布", published_at: "2026-09-01T19:00:00+08:00", link: null },
              { sentiment_id: "N2", policy_id: "P1", news_id: null, title: "答记者问", published_at: "2026-09-01T19:25:00+08:00", link: null },
            ] };
          }
          if (/FROM policy_article/.test(sql)) {
            return { results: [{
              policy_id: "P1",
              id: "A1",
              title: "房地产新政点评",
              author: "东财证券",
              summary: "研报摘要",
              published_at: "2026-09-01T20:00:00+08:00",
              link: null,
              association_method: "ai",
            }] };
          }
          if (/FROM commentary/.test(sql)) {
            return { results: [{
              id: "C1",
              policy_id: "P1",
              commentary_type: "policy_tracking",
              event_name: "房地产信贷管理新政",
              sources: "中国人民银行、国家金融监督管理总局",
              event_published_at: "2026-09-01",
              commentary_date: "2026-09-01",
              event_summary: "事件摘要",
              commentary: "政策点评",
              recommendation: "应对建议",
              model: "gpt-5.6-luna",
              prompt_version: "policy-commentary-v1",
              generated_at: "2026-09-01T12:00:00Z",
              edited: 0,
              updated_at: "2026-09-01T12:00:00Z",
            }] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
    },
  };
}

function fakeCommentaryGenerationDatabase() {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/FROM policy_event/.test(sql)) {
            return {
              id: "P1",
              title: "房地产信贷管理新政",
              summary: "政策摘要",
              category: "real_estate",
              departments_json: JSON.stringify(["中国人民银行"]),
              policy_date: "2026-09-01",
              first_news_at: "2026-09-01T19:00:00+08:00",
              last_news_at: "2026-09-01T19:00:00+08:00",
              updated_at: "2026-09-01T11:30:00Z",
            };
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        async all() {
          if (/FROM policy_news/.test(sql)) {
            return {
              results: [{
                id: "N1",
                title: "新政发布",
                published_at: "2026-09-01T19:00:00+08:00",
                content: "政策正文",
              }],
            };
          }
          if (/FROM policy_article/.test(sql)) return { results: [] };
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  };
}

function fakeDetailDatabase() {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/FROM article/.test(sql)) {
            return {
              id: "A1", title: "房地产新政点评", author: "东财证券",
              summary: "研报摘要", published_at: "2026-09-01T20:00:00+08:00",
              link: "https://example.com/report",
            };
          }
          if (/FROM commentary/.test(sql)) {
            return {
              id: "C1", policy_id: "P1", commentary_type: "policy_tracking",
              event_name: "房地产信贷管理新政", sources: "中国人民银行",
              event_published_at: "2026-09-01", commentary_date: "2026-09-01",
              event_summary: "事件摘要", commentary: "政策点评", recommendation: "应对建议",
              model: "gpt-5.6-luna", prompt_version: "policy-commentary-v1",
              generated_at: "2026-09-01T12:00:00Z", edited: 0,
              updated_at: "2026-09-01T12:00:00Z", policy_title: "房地产信贷管理新政",
              policy_summary: "政策摘要", policy_category: "real_estate", policy_date: "2026-09-01",
            };
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        async all() {
          if (/FROM policy_article/.test(sql)) {
            return { results: [{
              id: "P1", title: "房地产信贷管理新政", summary: "政策摘要",
              category: "real_estate", policy_date: "2026-09-01",
            }] };
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
      };
    },
  };
}

function fakePolicyNewsDetailDatabase() {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (/FROM policy_news pn/.test(sql)) {
            return {
              sentiment_id: "N1",
              news_id: "NEWS1",
              title: "房地产信贷管理新政发布",
              published_at: "2026-09-01T19:00:00+08:00",
              content: "DM 政策资讯原文",
              link: "https://example.com/policy",
              policy_id: "P1",
              policy_title: "房地产信贷管理新政",
              policy_summary: "政策摘要",
              policy_category: "real_estate",
              policy_date: "2026-09-01",
            };
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
      };
    },
  };
}
