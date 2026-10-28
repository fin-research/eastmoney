import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  companyBusinessNarrative,
  parseFinancingModelReport,
  sellSideSummaryBody,
  timingDecisionHistorySchema,
} from "../src/lib/financing-model.ts";
import { resolveInstitutionLogo } from "../src/lib/sell-side-institutions.ts";
import {
  loadFinancingModelReport,
  loadTimingDecisionHistory,
  saveFinancingModelConclusion,
  saveSellSideSnapshot,
  saveSellSideSummaryRevision,
  saveTimingDecisionRecord,
} from "../src/lib/server/financing-model-repository.ts";
import {
  aiSearchPeriod,
  generateFinancingModelResearch,
  buildAiSearchToolCall,
  parseAiSearchResponse,
} from "../src/lib/server/financing-model-research.ts";

function snapshot() {
  return {
    schema_version: 1,
    run_id: "78c6fba5-e7b0-4d0f-bc18-2c8968b8e447",
    model_name: "bond_financing_timing_lgbm",
    generated_at: "2026-08-24T02:00:00+00:00",
    as_of_date: "2026-08-24",
    market_data_date: "2026-08-21",
    issue_terms: {
      issue_size_billion_yuan: 30,
      tenor_years: 3,
      rating: "AAA",
      bond_type: "证券公司债",
    },
    prediction: {
      deviation_bp: 1.71,
      peer_spread_median_bp: 41.18,
      historical_percentile: 51,
      recommendation: "neutral",
      recommendation_label: "择机发行",
      window_zone: "中枢",
      decision: "推荐发行",
    },
    company_metrics: {
      date: "2026-08-21",
      ef_lcr: 5.832,
      ef_nsfr: 2.2347,
      ef_lcr_pctile_60d: 0.39,
      ef_nsfr_pctile_60d: 0.847,
      ef_funding_gap: -232.1,
      ef_margin_zscore_60d: 0,
      ef_funding_pressure: 1,
      ef_subject_spread_bp: 17.86,
      ef_subject_spread_pctile: 0.22,
      ef_subject_spread_date: "2026-08-21",
      composite_score: 0.6185,
      readiness_label: "宽裕",
      interpretation: "流动性充裕",
    },
    market_drivers: [
      {
        feature: "weighted_cost",
        display_name: "一级加权成本",
        shap: -0.3,
        value: 1.491,
        direction: "降低成本",
        impact: "降低成本",
      },
    ],
    driver_structure: [
      {
        category: "funding",
        display_name: "资金面",
        support_score: 62,
        support_bp: 0.3,
        importance_weight: 1,
      },
    ],
    product_recommendation: {
      recommended_product: "3Y 次级债",
      recommended_tenor_years: 3,
      recommended_bond_type: "证券公司次级债",
      scenarios: [
        ["3Y 公募债", 3, "证券公司债", 1.71, 2, false],
        ["5Y 公募债", 5, "证券公司债", 2.2, 4, false],
        ["3Y 次级债", 3, "证券公司次级债", -0.5, 1, true],
        ["5Y 次级债", 5, "证券公司次级债", 1.9, 3, false],
      ].map(([display_name, tenor_years, bond_type, pred_bp, rank, is_recommended]) => ({
        display_name,
        tenor_years,
        bond_type,
        pred_bp,
        peer_spread_median_bp: 41.18,
        historical_percentile: 51,
        recommendation: rank === 1 ? "strong_buy" : "neutral",
        recommendation_label: rank === 1 ? "建议发行" : "择机发行",
        rank,
        cost_vs_best_bp: pred_bp + 0.5,
        is_recommended,
      })),
    },
    forecast_window: [
      {
        date: "2026-08-24",
        weekday: "周一",
        percentile: 51,
        label: "尚可",
        pred_bp: 1.71,
        savings_bp_vs_window_median: -1.12,
        "savings_万元/年": -33.6,
      },
    ],
    validation: {
      tscv: {
        folds: 10,
        validation_samples: 100,
        sample_count: 2023,
        sample_start_date: "2022-01-01",
        sample_end_date: "2026-06-30",
        rmse: 8.4,
        mae: 6.2,
        ic: 0.22,
        best_iter_median: 80,
        best_iters: [80],
      },
      timing_value: {
        n_total: 100,
        n_recommended: 25,
        recommended_share: 0.25,
        cost_saving_bp: 2.1,
        recommended_mean_bp: -1,
        baseline_mean_bp: 1.1,
        win_rate: 0.6,
        ic: 0.22,
        group_means: [-1, 0, 1, 2],
        monotonic: true,
      },
    },
    base_conclusion: {
      verdict: "推荐发行",
      preferred_window: "8月24日",
      narrative: "基础结论",
      preferred_dates: ["2026-08-24"],
    },
    source_freshness: {
      market_data_date: "2026-08-21",
      company_metrics_date: "2026-08-21",
      subject_spread_date: "2026-08-21",
    },
  };
}

function sellSidePayload() {
  return {
    generatedAt: "2026-08-24T03:00:00.000Z",
    periodStart: "2026-08-18",
    periodEnd: "2026-08-24",
    searchQuery: "债券市场",
    maxResults: 50,
    sourceDocuments: 8,
    modelName: "gpt-5.6-luna",
    logicSummary: "资金面判断总体一致，但长端利率方向仍存在分歧。",
    edited: false,
    updatedAt: null,
    views: ["兴业固收", "天风固收", "华源固收", "中信固收"].map((institution, index) => ({
      institution,
      title: `${institution}周报`,
      publishedAt: "2026-08-24",
      stance: index === 2 ? "challenges" : "supports",
      summary: "资金面保持平稳。",
      implication: "发行窗口仍可关注。",
      sourceKey: `2026-08-24/${institution}.md`,
    })),
  };
}

function versions() {
  return [
    {
      runId: snapshot().run_id,
      asOfDate: snapshot().as_of_date,
      generatedAt: snapshot().generated_at,
    },
  ];
}

test("融资择时报告契约接受模型、人工结论和卖方观点", () => {
  const report = parseFinancingModelReport({
    snapshot: snapshot(),
    conclusion: {
      verdict: "抓住窗口发行",
      preferredWindow: "8月24日前后",
      narrative: "人工修订结论",
      edited: true,
      updatedAt: "2026-08-24T03:10:00.000Z",
    },
    sellSide: sellSidePayload(),
    versions: versions(),
  });

  assert.equal(report.snapshot.prediction.deviation_bp, 1.71);
  assert.equal(report.conclusion.edited, true);
  assert.equal(report.sellSide.views.length, 4);
  assert.equal(report.versions[0].asOfDate, "2026-08-24");
  assert.match(report.sellSide.logicSummary, /长端利率方向/);
});

test("公司业务指标结论隐藏资金缺口并保留发行节奏建议", () => {
  const narrative = companyBusinessNarrative(snapshot().company_metrics);

  assert.equal(
    narrative,
    "流动性整体宽裕；主体利差处于相对低位；公司融资需求较为迫切，建议尽快完成发行。",
  );
  assert.doesNotMatch(narrative, /\d/);

  const unhurried = companyBusinessNarrative({
    ...snapshot().company_metrics,
    ef_funding_gap: 60,
  });
  assert.doesNotMatch(unhurried, /资金缺口/);
  assert.match(unhurried, /公司融资需求暂不迫切，建议等待成本较优窗口择机完成发行/);

  const moderate = companyBusinessNarrative({
    ...snapshot().company_metrics,
    readiness_label: "适中",
    ef_funding_gap: -50,
  });
  assert.doesNotMatch(moderate, /资金缺口/);
  assert.match(moderate, /公司融资需求总体适中，建议结合市场窗口择机完成发行/);
});

test("卖方观点正文移除机构研报和发布日期引导句", () => {
  const summary =
    "德邦资管固收在《德邦资管固收投资周报0817-0821： 债市大概率以震荡整固为主， 警惕税期和政府债缴款对于资金面扰动和长端利率风险》（2026-08-24）指出。资金面均衡偏松格局未变。";

  assert.equal(
    sellSideSummaryBody(summary, "德邦资管固收"),
    "资金面均衡偏松格局未变。",
  );
  assert.equal(
    sellSideSummaryBody("资金面保持平稳。", "兴业固收"),
    "资金面保持平稳。",
  );
});

test("券商研究所 Logo 库按别名匹配官网图片且不伪造回退标识", () => {
  assert.equal(
    resolveInstitutionLogo("德邦资管固收")?.src,
    "/institution-logos/tebon.ico",
  );
  assert.equal(
    resolveInstitutionLogo("国联民生证券")?.src,
    "/institution-logos/glms.ico",
  );
  assert.equal(
    resolveInstitutionLogo("中信建投固收")?.src,
    "/institution-logos/csc.ico",
  );
  assert.equal(
    resolveInstitutionLogo("国泰君安研究")?.src,
    "/institution-logos/gtht.png",
  );
  assert.equal(
    resolveInstitutionLogo("华创固收团队")?.src,
    "/institution-logos/hczq.ico",
  );
  assert.equal(
    resolveInstitutionLogo("中金公司研究部")?.src,
    "/institution-logos/cicc.ico",
  );
  assert.equal(resolveInstitutionLogo("示例研究所"), null);
});

test("券商研究所 Logo 库包含 32 个本地图形资产", async () => {
  const files = [
    "boci.ico",
    "cicc.ico",
    "citics.ico",
    "cjsc.ico",
    "cms.ico",
    "csc.ico",
    "ctsec.png",
    "dfzq.ico",
    "dwzq.ico",
    "ebscn.ico",
    "founder.ico",
    "galaxy.ico",
    "gf.ico",
    "ghzq.jpg",
    "gjzq.ico",
    "glms.ico",
    "gszq.png",
    "gtht.png",
    "guosen.ico",
    "hczq.ico",
    "hfzq.png",
    "htsc.ico",
    "hx168.ico",
    "kysec.ico",
    "pingan.ico",
    "stocke.ico",
    "swhy.ico",
    "tebon.ico",
    "tfzq.ico",
    "west.png",
    "xyzq.png",
    "zts.ico",
  ];
  const signatures = [
    Buffer.from([0x00, 0x00, 0x01, 0x00]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from([0xff, 0xd8, 0xff]),
  ];

  for (const file of files) {
    const asset = await readFile(
      new URL(`../static/institution-logos/${file}`, import.meta.url),
    );
    assert.ok(asset.length >= 300, `${file} 应包含实际图片数据`);
    assert.ok(
      signatures.some((signature) =>
        asset.subarray(0, signature.length).equals(signature),
      ),
      `${file} 应为可识别的图片格式`,
    );
  }
});

test("历史卖方交叉验证快照读取时整合为单段逻辑汇总", () => {
  const legacy = sellSidePayload();
  delete legacy.logicSummary;
  delete legacy.edited;
  delete legacy.updatedAt;
  legacy.views = legacy.views.slice(0, 3);
  legacy.crossValidation = {
    alignment: "mixed",
    summary: "资金面总体偏松。",
    disagreements: ["信用债一级成本仍在上行。"],
  };

  const report = parseFinancingModelReport({
    snapshot: snapshot(),
    conclusion: {
      verdict: "推荐发行",
      preferredWindow: "8月24日",
      narrative: "基础结论",
      edited: false,
      updatedAt: null,
    },
    sellSide: legacy,
    versions: versions(),
  });

  assert.equal(
    report.sellSide.logicSummary,
    "资金面总体偏松；信用债一级成本仍在上行。",
  );
  assert.equal(report.sellSide.edited, false);
});

test("未人工编辑时整体结论跟随正式发行建议并返回日期版本", async () => {
  const client = {
    async query(sql, parameters) {
      assert.match(sql, /financing_model\.model_run/);
      assert.match(sql, /AS versions/);
      assert.deepEqual(parameters, [null]);
      return {
        rows: [
          {
            snapshot: snapshot(),
            verdict: "推荐发行",
            preferred_window: "8月24日",
            narrative: "基础结论",
            conclusion_updated_at: null,
            sell_side_payload: null,
            versions: versions(),
          },
        ],
      };
    },
  };

  const report = await loadFinancingModelReport(client);

  assert.equal(report.conclusion.verdict, "择机发行");
  assert.equal(report.conclusion.edited, false);
  assert.equal(report.sellSide, null);
  assert.equal(report.versions[0].runId, snapshot().run_id);
});

test("人工编辑过的整体结论保持优先", async () => {
  const client = {
    async query() {
      return {
        rows: [
          {
            snapshot: snapshot(),
            verdict: "暂缓发行",
            preferred_window: "等待确认",
            narrative: "人工判断等待更明确的成本窗口。",
            conclusion_updated_at: "2026-08-24T04:00:00.000Z",
            sell_side_payload: null,
            versions: versions(),
          },
        ],
      };
    },
  };

  const report = await loadFinancingModelReport(client);

  assert.equal(report.conclusion.verdict, "暂缓发行");
  assert.equal(report.conclusion.edited, true);
});

test("整体结论 PATCH 增量更新 model_run 当前结论", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return {
        rows: [
          {
            verdict: "等待",
            preferred_window: "8月末",
            narrative: "等待更优窗口。",
            updated_at: "2026-08-24T04:00:00.000Z",
          },
        ],
      };
    },
  };

  const result = await saveFinancingModelConclusion(client, {
    runId: snapshot().run_id,
    verdict: "等待",
    preferredWindow: "8月末",
    narrative: "等待更优窗口。",
  });

  assert.match(calls[0].sql, /UPDATE financing_model\.model_run/);
  assert.match(calls[0].sql, /conclusion_updated_at = now\(\)/);
  assert.doesNotMatch(calls[0].sql, /conclusion_revision|INSERT INTO/);
  assert.equal(calls[0].parameters[0], snapshot().run_id);
  assert.equal(result.edited, true);
});

test("历史择时决策记录只手工保存操作与结果并从 model_run 派生模型字段", async () => {
  const row = {
    run_id: snapshot().run_id,
    decision_date: "2026-08-24",
    historical_percentile: 51,
    recommendation: "neutral",
    recommendation_label: "择机发行",
    decision_action: "启动3年期公募债预沟通",
    outcome: "最终票面低于预算2bp",
    updated_at: "2026-08-25T02:00:00.000Z",
  };
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [row] };
    },
  };

  const saved = await saveTimingDecisionRecord(client, {
    runId: snapshot().run_id,
    decisionAction: row.decision_action,
    outcome: row.outcome,
  });
  const history = await loadTimingDecisionHistory(client);

  assert.match(calls[0].sql, /INSERT INTO financing_model\.timing_decision_record/);
  assert.match(calls[0].sql, /ON CONFLICT \(run_id\) DO UPDATE/);
  assert.match(calls[0].sql, /run\.historical_percentile/);
  assert.doesNotMatch(calls[0].sql, /\bstatus\b/);
  assert.equal(calls[0].parameters[1], snapshot().run_id);
  assert.equal(saved.decisionAction, row.decision_action);
  assert.equal(history[0].outcome, row.outcome);
  assert.deepEqual(timingDecisionHistorySchema.parse(history), history);
});

test("model_run migration 完整拆分 payload 并合并整体结论", async () => {
  const [migration, recommendationMigration, sampleMigration] = await Promise.all([
    readFile(
      new URL(
        "../financing-model-migrations/0002_structure_model_run.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../financing-model-migrations/0003_driver_groups_and_product_scenarios.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../financing-model-migrations/0004_model_sample_range.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(migration, /CREATE TABLE financing_model\.model_run_market_driver/);
  assert.match(migration, /CREATE TABLE financing_model\.model_run_forecast_window/);
  assert.match(migration, /base_conclusion_preferred_dates date\[\]/);
  assert.match(migration, /timing_group_means numeric\(20, 10\)\[\]/);
  assert.match(migration, /DROP TABLE financing_model\.conclusion_revision/);
  assert.match(migration, /DROP COLUMN payload/);
  assert.match(recommendationMigration, /ADD COLUMN lcr_value/);
  assert.match(recommendationMigration, /ADD COLUMN cv_mae/);
  assert.match(recommendationMigration, /model_run_driver_group/);
  assert.match(recommendationMigration, /model_run_product_scenario/);
  assert.match(recommendationMigration, /CREATE TABLE financing_model\.timing_decision_record/);
  assert.match(recommendationMigration, /decision_action text NOT NULL/);
  assert.match(recommendationMigration, /outcome text NOT NULL DEFAULT ''/);
  assert.doesNotMatch(recommendationMigration, /\bstatus\b/);
  assert.match(sampleMigration, /ADD COLUMN model_sample_count integer/);
  assert.match(sampleMigration, /model_sample_start_date date/);
  assert.match(sampleMigration, /model_sample_end_date date/);
});

test("卖方观点快照保存搜索口径和完整 payload", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [] };
    },
  };

  await saveSellSideSnapshot(client, snapshot(), sellSidePayload());

  assert.match(calls[0].sql, /sell_side_snapshot/);
  assert.equal(calls[0].parameters[1], snapshot().run_id);
  assert.match(calls[0].parameters[6], /"maxResults":50/);
});

test("卖方逻辑汇总编辑采用追加快照并保留检索证据", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [] };
    },
  };
  const updatedAt = "2026-08-24T04:30:00.000Z";

  const revised = await saveSellSideSummaryRevision(
    client,
    snapshot(),
    sellSidePayload(),
    {
      runId: snapshot().run_id,
      logicSummary: "资金面偏松有利于发行，但信用一级成本仍有刚性。",
    },
    updatedAt,
  );

  assert.match(calls[0].sql, /sell_side_snapshot/);
  assert.equal(calls[0].parameters[7], updatedAt);
  assert.match(calls[0].parameters[6], /资金面偏松有利于发行/);
  assert.match(calls[0].parameters[6], /兴业固收/);
  assert.equal(revised.edited, true);
  assert.equal(revised.updatedAt, updatedAt);
});

test("融资模型页面只展示发行建议、预测票面和真实SHAP，保留人工与卖方操作", async () => {
  const page = await readFile(new URL("../src/lib/pages/FinancingModelPage.svelte", import.meta.url), "utf8");
  assert.match(page, /parseIssuanceReport/);
  for (const field of ["snapshot.forecast", "explanation?.features"]) assert.ok(page.includes(field));
  for (const label of ["预测发行利率", "整体结论", "业务指标", "资金缺口", "主体利差", "四品种对比", "因子贡献", "预测命中率", "决策操作", "编辑卖方逻辑汇总"]) assert.ok(page.includes(label));
  assert.doesNotMatch(page, /90%区间|区间下限|区间上限/);
  assert.doesNotMatch(page, /窗口净节约|等待省钱概率|编辑整体结论/);
  assert.doesNotMatch(page, /snapshot\.(prediction|company_metrics|product_recommendation|forecast_window)/);
  assert.match(page, /renderIssuanceForecast/);
  assert.match(page, /renderFinancingDriverContributions/);
  assert.match(page, /InstitutionLogo/);
});

test("AI Search 固定检索最近七个上海自然日且最多返回50条", () => {
  const period = aiSearchPeriod("2026-08-24");
  const call = buildAiSearchToolCall("债券市场", period);
  const retrieval = call.params.arguments.ai_search_options.retrieval;

  assert.equal(period.startDate, "2026-08-18");
  assert.equal(period.endDate, "2026-08-24");
  assert.equal(period.startMs, Date.parse("2026-08-18T00:00:00+08:00"));
  assert.equal(period.endMs, Date.parse("2026-08-24T23:59:59.999+08:00"));
  assert.equal(retrieval.max_num_results, 50);
  assert.deepEqual(retrieval.filters.type, { $eq: "研报" });
  assert.deepEqual(retrieval.filters.published_at, {
    $gte: period.startMs,
    $lte: period.endMs,
  });
});

test("AI Search MCP SSE 响应按文章去重并保留机构元数据", () => {
  const chunks = [
    chunk("兴业固收", "兴业周报", "第一段"),
    chunk("兴业固收", "兴业周报", "第二段"),
    chunk("天风固收", "天风周报", "第三段"),
  ];
  const nested = JSON.stringify({ success: true, result: { chunks } });
  const envelope = JSON.stringify({
    result: { content: [{ type: "text", text: nested }] },
  });
  const documents = parseAiSearchResponse(`event: message\ndata: ${envelope}\n\n`);

  assert.equal(documents.length, 2);
  assert.equal(documents[0].institution, "兴业固收");
  assert.equal(documents[0].publishedAt, "2026-08-24");
  assert.match(documents[0].text, /第一段/);
  assert.match(documents[0].text, /第二段/);
});

function chunk(source, title, text) {
  return {
    text: `# ${title}\n\n${text}`,
    item: {
      key: `2026-08-24/${title}.md`,
      metadata: {
        source,
        published_at: Date.parse("2026-08-24T10:00:00+08:00"),
      },
    },
  };
}


test("sell-side calls the current research MCP and reports upstream failures", async () => {
  const calls = [];
  await assert.rejects(generateFinancingModelResearch(snapshot(), {}, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response("unavailable", { status: 503 });
  }), /HTTP 503/);
  assert.equal(calls[0].url, "https://research.hasbai.xyz/mcp");
  assert.equal(calls[0].body.params.name, "search");
  assert.equal(calls[0].body.params.arguments.ai_search_options.retrieval.max_num_results, 50);
  assert.deepEqual(calls[0].body.params.arguments.ai_search_options.retrieval.filters.type, { $eq: "研报" });
});
