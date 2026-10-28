import assert from "node:assert/strict";
import test from "node:test";
import { snapshot } from "./fixtures/market-resources.mjs";
import { buildMarketBriefingEvidence } from "../src/lib/server/market-briefing-evidence.ts";
import { assertMarketBriefingQuality, buildMarketBriefingPrompt, generateMarketBriefing, generateMarketBriefingFromNews } from "../src/lib/server/market-briefing.ts";

test("行情证据只投影当日数据，不泄露人工点评或公司债持仓", () => {
  const report = snapshot();
  report.focus_text = "人工答案不得用于生成";
  report.omo_operations = [
    { operation_date: report.report_date, operation_name: "到期", duration: "6M", amount_yi: -5000, interest_rate: null },
    { operation_date: "2026-08-24", operation_name: "投放", duration: "7D", amount_yi: 6000, interest_rate: null },
  ];
  report.funding_rates = [{ code: "DR007", rate: null, change_bp: null }];
  report.government_bonds = [-1, 1, 0, null].map((value, i) => ({ category: "国债", tenor: `${i + 1}Y`, code: `test${i}`, yield_rate: null, change_bp: value }));
  const card = buildMarketBriefingEvidence(report);
  assert.equal(card.omo_operations.length, 1);
  assert.equal(card.omo_operations[0].amount_yi, -5000);
  assert.equal(card.funding_rates[0].rate, null);
  assert.deepEqual(card.government_bond_directions, { prices_up: ["国债1Y"], prices_down: ["国债2Y"], unchanged: ["国债3Y"], unknown: ["国债4Y"] });
  assert.deepEqual(card.equities, [{ name: "上证指数", change_pct: 0.4 }]);
  assert.doesNotMatch(JSON.stringify(card), /focus_text|人工答案|inventory_bonds|secondary_bonds|stock_summary|stock_paragraphs/);
  const prompt = buildMarketBriefingPrompt("原始新闻", report);
  assert.ok(prompt.startsWith("原始新闻"));
  assert.match(prompt, /报告行情证据/);
  assert.doesNotMatch(prompt, /人工答案/);
});

test("超长或截断成稿拒绝交付，不直接裁切正文", () => {
  const bond = "弱需求支撑长端利率下行，供给压力限制空间。";
  assert.doesNotThrow(() => assertMarketBriefingQuality({ stock: "股市震荡。", bond }));
  assert.throws(() => assertMarketBriefingQuality({ stock: "完整".repeat(81) + "。", bond }), /篇幅或完整性/);
  assert.throws(() => assertMarketBriefingQuality({ stock: "尚未写完的因果", bond }), /篇幅或完整性/);
});

test("行业强弱按涨幅排序，缺失和过期行业不作为当日证据", () => {
  const report = snapshot();
  report.industries = [null, -2, 5, 0, 2, 1, -1, 3].map((value, i) => ({ name: `行业${i}`, change_pct: value, market_cap_yuan: 1 }));
  const before = structuredClone(report);
  const card = buildMarketBriefingEvidence(report);
  assert.deepEqual(card.industry_leaders.map(row => row.change_pct), [5, 3, 2]);
  assert.deepEqual(card.industry_laggards.map(row => row.change_pct), [-2, -1, 0]);
  assert.deepEqual(report, before);
  report.industry_data_date = "2026-08-24";
  assert.deepEqual(buildMarketBriefingEvidence(report).industry_leaders, []);
  assert.deepEqual(buildMarketBriefingEvidence(report).equities, []);
  assert.equal(buildMarketBriefingEvidence(report).turnover_change_yi, null);
});

test("生成拒绝错日行情，且不调用模型", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not call model"); });
  await assert.rejects(generateMarketBriefingFromNews({}, "2026-08-26", { news_text: "新闻", news_count: 1 }, { report: snapshot() }), /日期不一致/);
});

test("人工重新生成读取R2行情，模型不会看到旧点评", async t => {
  const report = { ...snapshot(), focus_text: "保密的人工修改答案", finalized_at: "2026-08-25T09:30:00Z" };
  let modelInput;
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    modelInput = JSON.parse(init.body).input[0].content;
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ stock: "股市判断。", bond: "债市判断。" }) }] }] });
  });
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "test", AI_GATEWAY_ID: "default", CF_AIG_TOKEN: "test",
    EASTMONEY: { get: async key => {
      assert.equal(key, "market-briefing/2026-08-25.json");
      return { size: 1000, json: async () => report };
    } },
    DATA: { fetch: async request => request.url.includes("stock-summary")
      ? Response.json({ title: "收评", time: "2026-08-25T15:00:00+08:00", paragraphs: ["股市新闻"] })
      : Response.json([]) },
  };
  await generateMarketBriefing(env, "2026-08-25");
  assert.match(modelInput, /报告行情证据/);
  assert.doesNotMatch(modelInput, /保密的人工修改答案/);
});
