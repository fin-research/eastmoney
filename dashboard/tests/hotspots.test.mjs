import assert from "node:assert/strict";
import test from "node:test";

import { parseHotspotAnalysis } from "../src/lib/hotspots.ts";

function hotspot(overrides = {}) {
  return {
    keyword: "OMO零投放",
    aliases: ["逆回购零操作"],
    explanation: "央行公开市场操作变化影响短端资金预期，并通过收益率曲线传导至利率债；后续操作量恢复将成为验证条件。",
    drivers: ["公开市场操作"],
    conflicts: [],
    heat: 85,
    assetImpacts: {
      fixedIncome: "短端收益率存在上行压力",
      equities: "证据不足",
    },
    evidence: [{ articleId: "A001", evidence: "央行当日未开展逆回购投放。" }],
    confidence: "high",
    ...overrides,
  };
}

test("单篇证据热点直接采用模型 heat 并强制封顶热度与置信度", () => {
  const result = parseHotspotAnalysis(
    JSON.stringify({
      date: "2026-08-14",
      marketSummary: "当日资金操作成为主要定价线索。",
      hotspots: Array.from({ length: 8 }, (_, index) =>
        hotspot({
          keyword: `热点${index + 1}`,
          heat: 100 - index,
        }),
      ),
      relationships: [],
      watchItems: ["后续逆回购操作量"],
      coverage: { analyzedArticleIds: ["wrong"], articleCount: 99 },
    }),
    { date: "2026-08-14", articleIds: ["A001"] },
  );

  assert.equal(result.hotspots[0].heat, 60);
  assert.equal(result.hotspots[0].confidence, "medium");
  assert.equal(result.hotspots[0].sourceLabel, "单一来源");
  assert.equal("score" in result.hotspots[0], false);
  assert.deepEqual(result.coverage, {
    analyzedArticleIds: ["A001"],
    articleCount: 1,
  });
});

test("证据去重且只保留最终关键词之间的关系", () => {
  const result = parseHotspotAnalysis(
    JSON.stringify({
      date: "2026-08-14",
      marketSummary: "资金与汇率共同影响跨资产定价。",
      hotspots: [
        hotspot({
          evidence: [
            { articleId: "A001", evidence: "证据一" },
            { articleId: "A001", evidence: "重复证据" },
            { articleId: "A002", evidence: "证据二" },
          ],
        }),
        hotspot({
          keyword: "美元兑日元",
          heat: 70,
          evidence: [{ articleId: "A002", evidence: "美元兑日元下行。" }],
        }),
        ...Array.from({ length: 6 }, (_, index) =>
          hotspot({
            keyword: `补充热点${index + 1}`,
            heat: 50 - index,
          }),
        ),
      ],
      relationships: [
        { source: "OMO零投放", target: "美元兑日元", explanation: "跨资产传导" },
        { source: "OMO零投放", target: "不存在", explanation: "无效端点" },
      ],
      watchItems: [],
      coverage: { analyzedArticleIds: [], articleCount: 0 },
    }),
    { date: "2026-08-14", articleIds: ["A001", "A002"] },
  );

  assert.equal(result.hotspots[0].evidence.length, 2);
  assert.equal(result.hotspots[0].sourceLabel, "多来源");
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0].target, "美元兑日元");
});

test("热点按模型 heat 排序且最多保留十五条", () => {
  const result = parseHotspotAnalysis(
    JSON.stringify({
      marketSummary: "热度由模型直接给出，应用不自行计算加权得分。",
      hotspots: Array.from({ length: 16 }, (_, index) =>
        hotspot({
          keyword: `热度热点${index + 1}`,
          evidence: [
            { articleId: "A001", evidence: "证据一" },
            { articleId: "A002", evidence: "证据二" },
          ],
          heat: 100 - index,
        }),
      ),
      relationships: [],
      watchItems: [],
    }),
    { date: "2026-08-14", articleIds: ["A001", "A002", "A003", "A004"] },
  );

  assert.equal(result.hotspots.length, 15);
  assert.equal(result.hotspots[0].heat, 100);
  assert.equal(result.hotspots[14].heat, 86);
  assert.deepEqual(
    result.hotspots.map((item) => item.heat),
    [...result.hotspots].sort((left, right) => right.heat - left.heat).map((item) => item.heat),
  );
});

test("缓存中的结果可重新校验并解析", () => {
  const context = { date: "2026-08-14", articleIds: ["A001"] };
  const first = parseHotspotAnalysis(
    JSON.stringify({
      marketSummary: "缓存复用仍须经过同一运行时校验。",
      hotspots: Array.from({ length: 8 }, (_, index) =>
        hotspot({ keyword: `缓存热点${index + 1}` }),
      ),
      relationships: [],
      watchItems: [],
    }),
    context,
  );
  const cached = parseHotspotAnalysis(JSON.stringify(first), context);

  assert.deepEqual(cached, first);
});

test("市场总览超过建议字数时仍完整接收", () => {
  const marketSummary = "热点总览允许模型根据证据完整表达，不因略微超出建议篇幅而拒绝整次聚合结果。".repeat(4);
  const result = parseHotspotAnalysis(
    JSON.stringify({
      marketSummary,
      hotspots: Array.from({ length: 8 }, (_, index) =>
        hotspot({ keyword: `长总览热点${index + 1}` }),
      ),
      relationships: [],
      watchItems: [],
    }),
    { date: "2026-08-19", articleIds: ["A001"] },
  );

  assert.ok(marketSummary.length > 120);
  assert.equal(result.marketSummary, marketSummary);
});
