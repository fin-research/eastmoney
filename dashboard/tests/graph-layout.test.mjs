import assert from "node:assert/strict";
import test from "node:test";

import { forceLayout, layoutGraph } from "../src/lib/graph-layout.ts";
import { litSets, matchingChains, nodeSize, tracePaths } from "../src/lib/knowledge-graph.ts";

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

test("按证据文章匹配传导链", () => {
  assert.equal(matchingChains(graph, ["a2"]).length, 1);
  assert.equal(matchingChains(graph, ["zzz"]).length, 0);
  assert.equal(matchingChains(graph, new Set(["a1"]), 0).length, 0);
});

test("节点大小随出现次数单调增长，面积近似与次数成正比，且有上下限", () => {
  assert.equal(nodeSize(0, 0), nodeSize(0, 10));
  assert.ok(nodeSize(1, 49) < nodeSize(10, 49));
  assert.ok(nodeSize(10, 49) < nodeSize(49, 49));
  assert.ok(nodeSize(0, 49) >= 14);
  assert.ok(nodeSize(49, 49) <= 62);
});

const flow = {
  ...graph,
  nodes: [...graph.nodes, { key: "地产债", label: "地产债", kind: "sector", weight: 1, articleCount: 1, lastSeenAt: "" }],
  edges: [
    ...graph.edges,
    { source: "存单利率", sourceMove: "rise", target: "地产债", effectMove: "fall", articleIds: ["a3"] },
    { source: "存单利率", sourceMove: "fall", target: "地产债", effectMove: "rise", articleIds: ["a4"] },
  ],
};

test("点击节点高亮上下游：方向衔接才继续，下游不回头，两侧各自计数", () => {
  const middle = tracePaths(flow, "dr007");
  assert.deepEqual([...middle.upstream], [0]);
  assert.deepEqual([...middle.downstream].sort(), [1, 3]);
  assert.deepEqual([...middle.nodes].sort(), ["dr007", "存单利率", "地产债", "降准"].sort());
  assert.ok(!middle.edges.has(2), "存单利率上行的边与 DR007 下行的结果不衔接");

  const first = tracePaths(flow, "降准");
  assert.deepEqual([...first.downstream].sort(), [0, 1, 3]);
  assert.equal(first.upstream.size, 0);

  const last = tracePaths(flow, "地产债");
  assert.deepEqual([...last.upstream].sort(), [0, 1, 2, 3]);
  assert.ok(!last.upstream.has(4));
  assert.equal(tracePaths(flow, "不存在").edges.size, 0);
});

test("跳数受限且遇到环不重复", () => {
  const ring = {
    ...graph,
    nodes: ["a", "b", "c", "d", "e"].map((key) => ({ key, label: key, kind: "market", weight: 1, articleCount: 1, lastSeenAt: "" })),
    edges: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "a"]].map(([source, target], index) => ({
      source, sourceMove: "rise", target, effectMove: "rise", articleIds: [`r${index}`],
    })),
    chains: [],
  };
  const traced = tracePaths(ring, "a", 2);
  assert.deepEqual([...traced.downstream].sort(), [0, 1]);
  assert.deepEqual([...traced.upstream].sort(), [3, 4]);
  assert.equal(tracePaths(ring, "a").nodes.size, 5);
});

test("选中的链、边、节点依次决定高亮集合，没有选择时不高亮", () => {
  assert.equal(litSets(flow, {}), null);
  assert.deepEqual([...litSets(flow, { chain: 0, edge: 1, node: "dr007" }).edges], [0, 1]);
  assert.deepEqual([...litSets(flow, { edge: 1, node: "dr007" }).nodes].sort(), ["dr007", "存单利率"].sort());
  assert.ok(litSets(flow, { node: "dr007" }).downstream.has(1));
});

test("力导向布局：确定性、不重叠、留在画布内、原因整体偏左", () => {
  const keys = Array.from({ length: 40 }, (_, index) => `n${index}`);
  const forceNodes = keys.map((key, index) => ({ key, radius: 10 + (index % 5) * 6 }));
  const forceEdges = keys.slice(1).map((key, index) => edge(keys[Math.floor(index / 2)], key, 1 + (index % 4)));
  const levels = new Map(layoutGraph(keys.map((key) => node(key)), forceEdges).nodes);
  const levelOf = new Map([...levels].map(([key, placed]) => [key, placed.level]));
  const options = { width: 760, height: 560, levels: levelOf };

  const first = forceLayout(forceNodes, forceEdges, options);
  const second = forceLayout(forceNodes, forceEdges, options);
  assert.deepEqual([...first], [...second]);

  for (const a of forceNodes) {
    const pa = first.get(a.key);
    assert.ok(pa.x >= a.radius - 0.001 && pa.x <= 760 - a.radius + 0.001);
    assert.ok(pa.y >= a.radius - 0.001 && pa.y <= 560 - a.radius + 0.001);
    for (const b of forceNodes) {
      if (a.key >= b.key) continue;
      const pb = first.get(b.key);
      assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) >= a.radius + b.radius - 0.5, `${a.key} 与 ${b.key} 重叠`);
    }
  }

  const mean = (keysOf) => keysOf.reduce((sum, key) => sum + first.get(key).x, 0) / keysOf.length;
  const deep = keys.filter((key) => levelOf.get(key) >= 3);
  const shallow = keys.filter((key) => levelOf.get(key) === 0);
  assert.ok(deep.length > 0 && shallow.length > 0);
  assert.ok(mean(shallow) < mean(deep));
});

test("力导向布局处理空图、单点和孤立点", () => {
  assert.equal(forceLayout([], [], { width: 100, height: 100 }).size, 0);
  const one = forceLayout([{ key: "a", radius: 5 }], [], { width: 100, height: 100 });
  assert.ok(Number.isFinite(one.get("a").x) && Number.isFinite(one.get("a").y));
  const lone = forceLayout([{ key: "a", radius: 5 }, { key: "b", radius: 5 }], [edge("a", "zzz")], { width: 100, height: 100 });
  assert.equal(lone.size, 2);
});
