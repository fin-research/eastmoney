import assert from "node:assert/strict";
import test from "node:test";

import { layoutGraph } from "../src/lib/graph-layout.ts";
import { describeChain, matchingChains } from "../src/lib/knowledge-graph.ts";

const node = (key, weight = 1) => ({ key, weight });
const edge = (source, target, weight = 1) => ({ source, target, weight });

test("原因在左、结果在右，同一列自上而下排布", () => {
  const layout = layoutGraph([node("a"), node("b"), node("c"), node("d")], [edge("a", "b"), edge("b", "c"), edge("a", "d")]);
  assert.equal(layout.nodes.get("a").level, 0);
  assert.equal(layout.nodes.get("b").level, 1);
  assert.equal(layout.nodes.get("c").level, 2);
  assert.equal(layout.nodes.get("d").level, 1);
  assert.ok(layout.nodes.get("a").x < layout.nodes.get("b").x);
  assert.ok(layout.nodes.get("b").x < layout.nodes.get("c").x);
  assert.notEqual(layout.nodes.get("b").y, layout.nodes.get("d").y);
});

test("反馈环不会让层级无限增长，所有节点都被放置在画布内", () => {
  const layout = layoutGraph([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
  for (const placed of layout.nodes.values()) {
    assert.ok(placed.level <= 4);
    assert.ok(placed.x + layout.nodeWidth <= layout.width);
    assert.ok(placed.y + layout.nodeHeight <= layout.height);
  }
  assert.equal(layout.nodes.size, 3);
});

test("自环被忽略，孤立节点落在第一列", () => {
  const layout = layoutGraph([node("a"), node("z")], [edge("a", "a")]);
  assert.equal(layout.nodes.get("a").level, 0);
  assert.equal(layout.nodes.get("z").level, 0);
});

test("较重的节点在同列排在前面，空图有最小尺寸", () => {
  const layout = layoutGraph([node("light", 1), node("heavy", 5)], []);
  assert.ok(layout.nodes.get("heavy").y < layout.nodes.get("light").y);
  const empty = layoutGraph([], []);
  assert.ok(empty.width > 0 && empty.height > 0);
});

const graph = {
  window: { start: "", end: "", anchor: "" },
  coverage: { articleCount: 0, claimArticleCount: 0, claimCount: 0, nodeCount: 0 },
  nodes: [
    { key: "降准", label: "降准", kind: "policy", weight: 1, articleCount: 1, lastSeenAt: "" },
    { key: "dr007", label: "DR007", kind: "market", weight: 1, articleCount: 1, lastSeenAt: "" },
    { key: "存单利率", label: "存单利率", kind: "market", weight: 1, articleCount: 1, lastSeenAt: "" },
  ],
  edges: [
    { source: "降准", sourceMove: "occur", target: "dr007", effectMove: "fall", articleIds: ["a1"] },
    { source: "dr007", sourceMove: "fall", target: "存单利率", effectMove: "fall", articleIds: ["a2"] },
  ],
  chains: [{ nodes: ["降准", "dr007", "存单利率"], edges: [0, 1], weight: 1 }],
};

test("传导链文字带出每个节点在链中的方向", () => {
  assert.equal(describeChain(graph, graph.chains[0]), "降准● → DR007↓ → 存单利率↓");
});

test("按证据文章匹配传导链", () => {
  assert.equal(matchingChains(graph, ["a2"]).length, 1);
  assert.equal(matchingChains(graph, ["zzz"]).length, 0);
  assert.equal(matchingChains(graph, new Set(["a1"]), 0).length, 0);
});
