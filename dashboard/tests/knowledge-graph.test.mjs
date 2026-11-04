import assert from "node:assert/strict";
import test from "node:test";

import { buildKnowledgeGraph, normalizeNodeKey } from "../src/lib/server/knowledge-graph.ts";

const options = { start: "2026-10-21", end: "2026-11-03", days: 14, articleCount: 10, claimArticleCount: 6 };

function claim(overrides = {}) {
  return {
    article_id: "a1",
    cause: "降准",
    cause_move: "occur",
    effect: "DR007",
    effect_move: "fall",
    basis: "observed",
    mechanism: "流动性投放压低资金利率。",
    title: "研报一",
    author: "机构甲",
    published_at: "2026-11-03T02:00:00.000Z",
    importance: 80,
    ...overrides,
  };
}

const edgeOf = (graph, source, target) => graph.edges.find((edge) => edge.source === source && edge.target === target);

test("节点键统一全角、大小写、空白和常见别名", () => {
  assert.equal(normalizeNodeKey(" ＤＲ００７ "), "dr007");
  assert.equal(normalizeNodeKey("10年期国债收益率"), normalizeNodeKey("十年国债收益率"));
  assert.equal(normalizeNodeKey("10年 国债收益率"), "10年国债收益率");
});

test("空窗口返回空结构而不是错误", () => {
  const graph = buildKnowledgeGraph([], [], options);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.chains, []);
  assert.equal(graph.coverage.articleCount, 10);
  assert.equal(graph.window.anchor, "");
});

test("同一边的多篇文章累加，同一篇文章只计一次", () => {
  const graph = buildKnowledgeGraph(
    [
      claim(),
      claim({ article_id: "a1", mechanism: "同篇重复" }),
      claim({ article_id: "a2", author: "机构乙", title: "研报二", importance: 60 }),
    ],
    [],
    options,
  );
  const edge = edgeOf(graph, "降准", "dr007");
  assert.deepEqual(edge.articleIds.sort(), ["a1", "a2"]);
  assert.equal(edge.authorCount, 2);
  assert.equal(edge.weight, 1.4);
  assert.equal(edge.observed, 2);
  assert.equal(edge.contested, false);
  assert.equal(edge.effectMove, "fall");
  assert.equal(graph.coverage.claimCount, 3);
});

test("时效衰减以最新主张为锚点，周末不会让整个窗口变淡", () => {
  const old = buildKnowledgeGraph([claim({ published_at: "2026-10-30T02:00:00.000Z" })], [], options);
  assert.equal(edgeOf(old, "降准", "dr007").weight, 0.8);

  const mixed = buildKnowledgeGraph(
    [claim(), claim({ article_id: "a2", published_at: "2026-10-31T02:00:00.000Z" })],
    [],
    options,
  );
  // a2 is 3 days older than the anchor: one half-life.
  assert.equal(edgeOf(mixed, "降准", "dr007").weight, 1.2);
});

test("相反方向的主张在同一对节点上标记为冲突并取权重大的方向", () => {
  const graph = buildKnowledgeGraph(
    [
      claim({ article_id: "a1", importance: 80 }),
      claim({ article_id: "a2", effect_move: "rise", importance: 40 }),
      claim({ article_id: "a3", cause: "LPR", effect: "银行股", effect_move: "rise", importance: 50 }),
      claim({ article_id: "a4", cause: "LPR", effect: "银行股", effect_move: "fall", importance: 5 }),
    ],
    [],
    options,
  );
  const contested = edgeOf(graph, "降准", "dr007");
  assert.equal(contested.contested, true);
  assert.equal(contested.effectMove, "fall");
  assert.equal(contested.riseWeight, 0.4);
  assert.equal(contested.fallWeight, 0.8);
  assert.equal(edgeOf(graph, "lpr", "银行股").contested, false);
});

test("趋势：新增、升温、平稳和降温", () => {
  const day = (offset) => new Date(Date.parse("2026-11-03T02:00:00.000Z") - offset * 86_400_000).toISOString();
  const rows = [
    // new: only recent
    claim({ article_id: "n1", cause: "新事件", effect: "新资产", published_at: day(0) }),
    // rising: 3 recent vs 1 base
    ...[0, 1, 2].map((offset) => claim({ article_id: `r${offset}`, cause: "升温因", effect: "升温果", published_at: day(offset) })),
    claim({ article_id: "r9", cause: "升温因", effect: "升温果", published_at: day(8) }),
    // fading: nothing recent, five older
    ...[5, 6, 7, 8, 9].map((offset) => claim({ article_id: `f${offset}`, cause: "降温因", effect: "降温果", published_at: day(offset) })),
    // steady: one recent, three base (rate 0.9 per 3 days)
    claim({ article_id: "s0", cause: "平稳因", effect: "平稳果", published_at: day(0) }),
    ...[4, 6, 8].map((offset) => claim({ article_id: `s${offset}`, cause: "平稳因", effect: "平稳果", published_at: day(offset) })),
  ];
  const graph = buildKnowledgeGraph(rows, [], options);
  assert.equal(edgeOf(graph, "新事件", "新资产").trend, "new");
  assert.equal(edgeOf(graph, "升温因", "升温果").trend, "rising");
  assert.equal(edgeOf(graph, "降温因", "降温果").trend, "fading");
  assert.equal(edgeOf(graph, "平稳因", "平稳果").trend, "steady");
});

test("传导链：方向衔接、不成环、至多三跳、不含冲突边，子链被长链吸收", () => {
  const rows = [
    claim({ article_id: "c1", cause: "降准", cause_move: "occur", effect: "DR007", effect_move: "fall", importance: 90 }),
    claim({ article_id: "c2", cause: "DR007", cause_move: "fall", effect: "1年存单利率", effect_move: "fall", importance: 80 }),
    claim({ article_id: "c3", cause: "1年存单利率", cause_move: "fall", effect: "债券杠杆", effect_move: "rise", importance: 70 }),
    claim({ article_id: "c4", cause: "债券杠杆", cause_move: "rise", effect: "降准", effect_move: "rise", importance: 70 }),
    // direction mismatch: needs DR007 to rise, but the chain delivers a fall
    claim({ article_id: "c5", cause: "DR007", cause_move: "rise", effect: "银行股", effect_move: "fall", importance: 90 }),
  ];
  const graph = buildKnowledgeGraph(rows.filter((row) => row.article_id !== "c4"), [], options);
  const labels = graph.chains.map((chain) => chain.nodes.join(">"));
  assert.deepEqual(labels, ["降准>dr007>1年存单利率>债券杠杆"]);
  assert.equal(graph.chains[0].edges.length, 3);
  assert.equal(graph.chains[0].weight, graph.edges[graph.chains[0].edges[2]].weight);
  assert.ok(!labels.some((value) => value.includes("银行股")));

  // A feedback loop never repeats a node inside one chain.
  const looped = buildKnowledgeGraph(rows, [], options);
  for (const chain of looped.chains) {
    assert.equal(new Set(chain.nodes).size, chain.nodes.length);
    assert.ok(chain.edges.length >= 2 && chain.edges.length <= 3);
  }
});

test("focus 精确匹配优先，否则做部分匹配，并只保留相关边与链", () => {
  const rows = [
    claim({ article_id: "c1", cause: "降准", effect: "DR007" }),
    claim({ article_id: "c2", cause: "DR007", cause_move: "fall", effect: "存单利率", effect_move: "fall" }),
    claim({ article_id: "c3", cause: "地产销售", cause_move: "fall", effect: "地产债", effect_move: "fall" }),
  ];
  const exact = buildKnowledgeGraph(rows, [], { ...options, focus: "DR007" });
  assert.equal(exact.edges.length, 2);
  assert.equal(exact.chains.length, 1);
  assert.ok(!exact.nodes.some((node) => node.key === "地产债"));

  const partial = buildKnowledgeGraph(rows, [], { ...options, focus: "地产" });
  assert.deepEqual(partial.edges.map((edge) => edge.source), ["地产销售"]);

  assert.deepEqual(buildKnowledgeGraph(rows, [], { ...options, focus: "不存在" }).edges, []);
});

test("节点取最常见写法和类型，并统计文章数", () => {
  const graph = buildKnowledgeGraph(
    [
      claim({ article_id: "a1", effect: "DR007" }),
      claim({ article_id: "a2", effect: "ＤＲ００７" }),
      claim({ article_id: "a3", effect: "DR007" }),
    ],
    [
      { article_id: "a1", label: "DR007", kind: "market" },
      { article_id: "a2", label: "ＤＲ００７", kind: "market" },
      { article_id: "a3", label: "DR007", kind: "macro" },
    ],
    options,
  );
  const node = graph.nodes.find((item) => item.key === "dr007");
  assert.equal(node.label, "DR007");
  assert.equal(node.kind, "market");
  assert.equal(node.articleCount, 3);
  assert.equal(graph.nodes.find((item) => item.key === "降准").kind, "event");
});

test("每条边最多保留 5 条最新主张证据，且边数受上限约束", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    claim({ article_id: `m${index}`, published_at: new Date(Date.parse("2026-11-03T02:00:00.000Z") - index * 3_600_000).toISOString() }),
  );
  const edge = edgeOf(buildKnowledgeGraph(rows, [], options), "降准", "dr007");
  assert.equal(edge.claims.length, 5);
  assert.deepEqual(edge.claims.map((item) => item.articleId), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(edge.articleIds.length, 8);

  const wide = Array.from({ length: 100 }, (_, index) => claim({ article_id: `w${index}`, cause: `因${index}`, effect: `果${index}` }));
  assert.equal(buildKnowledgeGraph(wide, [], options).edges.length, 40);
});

test("聚焦的边数同样受上限约束，截断标志原样带出", () => {
  const rows = Array.from({ length: 100 }, (_, index) => claim({ article_id: `f${index}`, cause: `债因${index}`, effect: `债果${index}` }));
  const graph = buildKnowledgeGraph(rows, [], { ...options, focus: "债", truncated: true });
  assert.equal(graph.edges.length, 40);
  assert.equal(graph.coverage.truncated, true);
  assert.equal(buildKnowledgeGraph([], [], options).coverage.truncated, false);
});

test("同一篇文章经别名合并后出现相反方向，证据列表允许同一文章出现两次", () => {
  const graph = buildKnowledgeGraph(
    [
      claim({ article_id: "x1", effect: "10年期国债收益率", effect_move: "fall" }),
      claim({ article_id: "x1", effect: "十年国债收益率", effect_move: "rise" }),
    ],
    [],
    options,
  );
  const edge = graph.edges.find((item) => item.target === "10年国债收益率");
  assert.equal(edge.contested, true);
  assert.deepEqual(edge.claims.map((item) => item.articleId), ["x1", "x1"]);
  assert.deepEqual(edge.articleIds, ["x1"]);
});
