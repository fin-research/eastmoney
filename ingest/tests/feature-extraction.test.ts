import { describe, expect, it } from "vitest";

import {
  ARTICLE_FEATURE_MODEL,
  articleFeatureOutputSchema,
  articleFeatureSchema,
  buildFeatureInferenceRequest,
  buildR2Metadata,
  nodeKey,
  extractArticleFeatures,
  normalizeClaims,
  validateArticleFeatures,
  type ArticleFeatures,
} from "../src/feature-extraction";

const validFeatures: ArticleFeatures = {
  title: "债市如何定价降准降息？",
  author: "国海固收",
  summary: "研报讨论宽松政策的条件与约束，并提示利率债定价需等待关键外部条件验证。",
  importance: 72,
  nodes: [
    {
      label: "降准降息预期",
      kind: "policy",
      fact: "研报认为基本面与银行息差约束减弱，宽松预期有合理性。",
      impact: "流动性改善预期可能提振股票估值并利多利率债，但债券定价需防范宽松预期抢跑。",
    },
    {
      label: "10年国债收益率",
      kind: "market",
      fact: "长端利率对宽松预期已有部分定价。",
      impact: "宽松落地节奏偏慢时收益率下行空间有限，宜控制久期。",
    },
    {
      label: "银行股",
      kind: "sector",
      fact: "息差约束是政策空间的主要制约。",
      impact: "息差压力缓解将提振银行股估值。",
    },
  ],
  claims: [
    {
      cause: "降准降息预期",
      causeMove: "rise",
      effect: "10年国债收益率",
      effectMove: "fall",
      basis: "expected",
      mechanism: "宽松预期升温会压低长端利率。",
    },
  ],
};

const validClaim = validFeatures.claims[0]!;
const nodeKeys = new Set(validFeatures.nodes.map((node) => nodeKey(node.label)));

describe("article feature extraction", () => {
  it("uses gpt-6-luna Responses while keeping thinking disabled", () => {
    expect(ARTICLE_FEATURE_MODEL).toBe("gpt-6-luna");
  });

  it("sends complete evidence separately from instructions with the versioned business schema", () => {
    const markdown = "中".repeat(100_000);
    const request = buildFeatureInferenceRequest("标题", markdown);

    expect(request.schema).toBe(articleFeatureOutputSchema);
    expect(articleFeatureSchema.safeParse(validFeatures).success).toBe(true);
    expect(request.schemaName).toBe("article_features");
    expect(request.promptCacheKey).toBe(
      "article-features:v6-causal-claims",
    );
    expect(request.taskType).toBe("summary");
    expect(request.enableThinking).toBe(false);
    expect(request.messages[0]?.content).not.toContain(markdown);
    expect(request.messages[1]?.content).toContain(markdown);
    expect(request.messages[1]?.content).toContain("响应 JSON Schema");
    expect(request.messages[1]?.content).not.toContain('"importance":70');
    expect(request.messages[1]?.content).not.toContain("权益：影响；利率债：影响");
    expect(request.messages[1]?.content).not.toContain("中间部分已省略");
  });

  it("rejects a result that does not satisfy the domain contract", async () => {
    await expect(
      extractArticleFeatures(
        async () => ({ ...validFeatures, importance: 101 }),
        validFeatures.title,
        "正文",
      ),
    ).rejects.toThrow("importance");
  });

  it("accepts the AI SDK object and preserves the source title", async () => {
    const extracted = await extractArticleFeatures(
      async () => ({ ...validFeatures, title: "模型改写标题" }),
      validFeatures.title,
      "正文",
    );

    expect(extracted).toEqual(validFeatures);
  });

  it("rejects invalid importance and bad node kinds, and keeps the first of duplicate labels", () => {
    expect(() =>
      validateArticleFeatures({ ...validFeatures, importance: 101 }, validFeatures.title),
    ).toThrow("importance");
    const duplicated = validateArticleFeatures(
      { ...validFeatures, nodes: [validFeatures.nodes[0], { ...validFeatures.nodes[0], label: " 降准降息 预期", fact: "后写重复" }] },
      validFeatures.title,
    );
    expect(duplicated.nodes).toEqual([validFeatures.nodes[0]]);
    expect(() =>
      validateArticleFeatures(
        { ...validFeatures, nodes: [{ ...validFeatures.nodes[0], kind: "company" }] },
        validFeatures.title,
      ),
    ).toThrow("kind");
    expect(() =>
      validateArticleFeatures({ ...validFeatures, nodes: [] }, validFeatures.title),
    ).toThrow("nodes");
    expect(
      validateArticleFeatures(
        { ...validFeatures, nodes: [{ ...validFeatures.nodes[0], label: "货币政策预期" }], claims: [] },
        validFeatures.title,
      ).nodes[0]?.label,
    ).toBe("货币政策预期");
  });

  it("builds R2 archive and indexing metadata from node labels", () => {
    expect(buildR2Metadata(validFeatures, "2026-08-13T01:02:03Z")).toEqual({
      type: "研报",
      source: "国海固收",
      tags: "降准降息预期,10年国债收益率,银行股",
      author: "国海固收",
      summary: validFeatures.summary,
      importance: "72",
      keywords: "降准降息预期,10年国债收益率,银行股",
      published_at: "2026-08-13T01:02:03.000Z",
    });
  });

  it("appends recent node labels after the evidence and keeps the system prompt unchanged", () => {
    const plain = buildFeatureInferenceRequest("标题", "正文");
    const withLabels = buildFeatureInferenceRequest("标题", "正文", ["DR007", "10年国债收益率"]);

    expect(withLabels.messages[0]?.content).toBe(plain.messages[0]?.content);
    expect(plain.messages[1]?.content).not.toContain("近期已有节点");
    const user = withLabels.messages[1]?.content ?? "";
    expect(user.indexOf("正文")).toBeLessThan(user.indexOf("近期已有节点：DR007、10年国债收益率"));
  });

  it("defaults to no claims when the model omits them", () => {
    const { claims: _claims, ...legacy } = validFeatures;
    expect(validateArticleFeatures(legacy, validFeatures.title).claims).toEqual([]);
  });

  it("accepts a legal claim through the full validation path", () => {
    expect(validateArticleFeatures(validFeatures, validFeatures.title).claims).toEqual([validClaim]);
  });

  it.each([
    ["self loop after normalization", { effect: " 降准降息 预期" }],
    ["endpoint that is not a node of the article", { effect: "不存在的节点" }],
    ["unknown move", { effectMove: "occur" }],
    ["unknown basis", { basis: "maybe" }],
    ["over-long endpoint", { cause: "一".repeat(161) }],
    ["empty mechanism", { mechanism: "  " }],
    ["over-long mechanism", { mechanism: "字".repeat(161) }],
  ])("drops a claim with %s without failing the article", (_name, patch) => {
    const good = { ...validClaim, effect: "银行股" };
    const features = validateArticleFeatures(
      { ...validFeatures, claims: [{ ...validClaim, ...patch }, good] },
      validFeatures.title,
    );

    expect(features.nodes).toEqual(validFeatures.nodes);
    expect(features.claims).toEqual([good]);
  });

  it("matches claim endpoints to nodes ignoring width, case and spaces", () => {
    const claims = normalizeClaims([{ ...validClaim, effect: "10年 国债收益率" }], nodeKeys);
    expect(claims).toHaveLength(1);
  });

  it("drops duplicate claims and keeps at most six", () => {
    const duplicate = [validClaim, { ...validClaim, cause: "降准降息 预期", mechanism: "重复" }];
    expect(normalizeClaims(duplicate, nodeKeys)).toEqual([validClaim]);

    const labels = Array.from({ length: 9 }, (_, index) => `资产${index}`);
    const keys = new Set([nodeKey("降准降息预期"), ...labels.map(nodeKey)]);
    const many = labels.map((effect) => ({ ...validClaim, effect }));
    expect(normalizeClaims(many, keys)).toHaveLength(6);
    expect(normalizeClaims("claims", keys)).toEqual([]);
    expect(normalizeClaims([null, 3, []], keys)).toEqual([]);
  });

  it("normalizes node keys across width, case and whitespace", () => {
    expect(nodeKey(" ＤＲ００７ ")).toBe("dr007");
    expect(nodeKey("10年 国债收益率")).toBe(nodeKey("10年国债收益率"));
  });
});
