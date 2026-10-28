import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTextReport,
  buildTextReportHtml,
  buildTextReportLines,
  buildTextReportLinesFromText,
} from "../src/text-report.ts";
import { applyTextReportEdits } from "../src/text-report-editor.ts";

const data = {
  report_date: "2026-08-13",
  generated_at: "2026-08-13T15:00:00+08:00",
  omo_operations: [
    { operation_date: "2026-08-13", duration: "7D", operation_name: "逆回购", amount_yi: 1185, interest_rate: 1.4 },
    { operation_date: "2026-08-13", duration: "14D", operation_name: "逆回购", amount_yi: 500, interest_rate: null },
    { operation_date: "2026-08-13", duration: "7D", operation_name: "逆回购", amount_yi: -1385, interest_rate: 1.4 },
  ],
  funding_rates: [
    { code: "DR001", rate: 1.4, change_bp: -2 }, { code: "DR007", rate: 1.5, change_bp: 0 },
    { code: "DIBO001", rate: 1.7, change_bp: 1 }, { code: "DIBO007", rate: 1.8, change_bp: 2 },
  ],
  government_bonds: [
    { category: "国债", tenor: "超长期限", code: "2500001", yield_rate: 2, change_bp: -1 },
    { category: "国债", tenor: "10Y", code: "2500002", yield_rate: 1.8, change_bp: -2 },
    { category: "国债", tenor: "5Y", code: "2500003", yield_rate: 1.6, change_bp: 1 },
    { category: "国债", tenor: "1Y", code: "2500004", yield_rate: 1.4, change_bp: 2 },
    { category: "国开", tenor: "10Y", code: "2502001", yield_rate: 1.9, change_bp: 0 },
  ],
  futures: [
    { code: "TL9999", last_price: 110.5, change_pct: 0.1 }, { code: "T9999", last_price: 108, change_pct: -0.2 },
    { code: "TF9999", last_price: 106, change_pct: 0 }, { code: "TS9999", last_price: 102, change_pct: 0.3 },
  ],
  stock_paragraphs: ["A股主要指数集体收涨。", "全市场成交保持活跃。"],
  margin: { data_date: "2026-08-12", total: 21000.5, total_change: 100.5, financing: 20800, financing_change: -50, securities_lending: 200.5, securities_lending_change: 150.5 },
  equities: [], equity_data_time: null, turnover_yi: null, turnover_change_yi: null,
  industries: [], industry_data_date: "2026-08-13", primary_summary: { current_amount: 150, change_amount: null },
  primary_issues: [
    { issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "甲证券", category: "短融", bond_names: ["26甲D1"], tenors: ["180天"], coupons: [1.5], amount: 10 },
    { issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "乙证券", category: "公募短债", bond_names: ["26乙S1"], tenors: ["182天"], coupons: [1.6], amount: 20 },
    { issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "丙证券", category: "小公募", bond_names: ["26丙01"], tenors: ["3年"], coupons: [1.7], amount: 30 },
    { issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "丁证券", category: "次级债", bond_names: ["26丁C1"], tenors: ["2+N年"], coupons: [1.8], amount: 40 },
    { issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "戊证券", category: "私募债", bond_names: ["26戊01"], tenors: ["2年"], coupons: [1.9], amount: 50 },
  ],
  secondary_bonds: [
    { bond_id: "1", bond_name: "25甲G1", issuer: "甲证券", tenor_label: "3.1Y", tenor_years: 3.1, valuation: 1.71, trade_yield: 1.72 },
    { bond_id: "2", bond_name: "25乙01", issuer: "国投证券", tenor_label: "2.1Y", tenor_years: 2.1, valuation: 1.61, trade_yield: 1.62 },
    { bond_id: "3", bond_name: "25丙01", issuer: "丙证券", tenor_label: "329D", tenor_years: 329 / 365, valuation: 1.51, trade_yield: 1.52 },
  ],
  inventory_bonds: [
    { bond_name: "25东财G1", tenor_label: "180D", tenor_years: 180 / 365, valuation: 1.55, trade_yield: 1.56, trade_spread_bp: 1.25, bid_yield: null, ofr_yield: null },
    { bond_name: "25东财G2", tenor_label: "1.2Y", tenor_years: 1.2, valuation: 1.65, trade_yield: null, trade_spread_bp: null, bid_yield: 1.66, ofr_yield: 1.64 },
  ],
};

test("前端文字报告使用规范契约复刻核心段落", () => {
  const report = buildTextReport(data);
  assert.ok(report.startsWith("20260813 境内市场点评"));
  assert.ok(report.includes("净投放300亿元"));
  assert.ok(report.includes("DR001报1.4000%，跌2.00bp"));
  assert.ok(report.includes("融资融券余额合计21000.50亿元"));
  assert.ok(report.includes("08/13-丙证券-3年-30亿-1.70%"));
  assert.ok(report.includes("3.1年-甲证券(25甲G1)-估值1.71%-成交1.72%"));
  assert.ok(report.includes("180天-25东财G1-估值1.55%-成交1.56%(+1.25bp)"));
});

test("一级发行与二级行情只展示共享加工层筛选结果", () => {
  const report = buildTextReport(data);
  assert.ok(!report.includes("东方财富证券"));
  assert.ok(report.includes("国投证券"));
});

test("一级发行展示共享加工层已合并的发行腿", () => {
  const input = structuredClone(data);
  input.primary_issues[2] = { ...input.primary_issues[2], bond_names: ["26丙01", "26丙02"], tenors: ["3年", "5年"], coupons: [1.7, 2.28], amount: 42.4 };
  const report = buildTextReport(input);
  assert.ok(report.includes("08/13-丙证券-3年/5年-42亿-1.70%/2.28%"));
});

test("文字版保留零报价债券但不显示 Bid/Ofr", () => {
  const input = structuredClone(data);
  input.inventory_bonds.push({
    bond_name: "25东财G3", tenor_label: "2Y", tenor_years: 2,
    valuation: 1.75, trade_yield: null, trade_spread_bp: null,
    bid_yield: 0, ofr_yield: 0,
  });
  const report = buildTextReport(input);
  assert.ok(report.includes("25东财G3-估值1.75%"));
  assert.ok(!report.includes("Bid0%"));
  assert.ok(!report.includes("Ofr0%"));
});

test("文字版加粗东财债券有成交的行", () => {
  const tradedLine = "180天-25东财G1-估值1.55%-成交1.56%(+1.25bp)";
  const lines = buildTextReportLines(data, tradedLine);
  assert.deepEqual(
    lines.filter((line) => line.bold).map((line) => line.text),
    [tradedLine],
  );
});

test("报告日未开展逆回购时显示完整文案", () => {
  const input = structuredClone(data);
  input.omo_operations = [{
    operation_date: "2026-08-13",
    duration: "7D",
    operation_name: "逆回购",
    amount_yi: -500,
    interest_rate: 1.4,
  }];
  const report = buildTextReport(input);
  assert.ok(report.includes("【央行】\n今日未开展逆回购操作；"));
  assert.ok(!report.includes("中国央行今日开展；"));
});

test("文字版展示当前手动修改后的今日聚焦", () => {
  assert.ok(buildTextReport(data, "手动修改后的判断").endsWith("【今日聚焦】\n手动修改后的判断\n"));
});

test("文字版富文本使用块级换行并保留成交行加粗", () => {
  const text = buildTextReport(data, "手动修改后的判断");
  const html = buildTextReportHtml(buildTextReportLinesFromText(data, text));
  assert.match(html, /^<div>20260813 境内市场点评<\/div><div><br><\/div>/);
  assert.match(
    html,
    /<div><strong>180天-25东财G1-估值1\.55%-成交1\.56%\(\+1\.25bp\)<\/strong><\/div>/,
  );
  assert.ok(!html.includes("\n"));
});

test("单个数据源失败时文字版只标记依赖段落并保留其余内容", () => {
  const report = buildTextReport(
    data,
    "手动判断",
    ["bondInfos", "fundingDr", "margin"],
  );
  assert.match(report, /DR资金利率数据缺失。/);
  assert.match(report, /DIBO001报1\.7000%/);
  assert.doesNotMatch(report, /DR001报--%/);
  assert.match(report, /融资融券数据缺失。/);
  assert.match(report, /可比证券公司债券成交数据缺失。/);
  assert.match(report, /东财存量债券数据缺失。/);
  assert.match(report, /7天期逆回购1185亿元/);
  assert.match(report, /08\/13-丙证券-3年-30亿-1\.70%/);
});

test("文字版编辑回写结构化数据并联动图表版", () => {
  const edited = buildTextReport(data, "原始判断")
    .replace("DR001报1.4000%，跌2.00bp", "DR001报1.4500%，涨3.00bp")
    .replace(
      "A股主要指数集体收涨。全市场成交保持活跃。",
      "A股主要指数震荡收涨。",
    )
    .replace("08/13-丙证券-3年-30亿-1.70%", "08/13-丙证券-3年-35亿-1.75%")
    .replace(
      "180天-25东财G1-估值1.55%-成交1.56%(+1.25bp)",
      "180天-25东财G1-估值1.57%-成交1.58%(+1.00bp)",
    )
    .replace("【今日聚焦】\n原始判断", "【今日聚焦】\n更新后的判断");
  const result = applyTextReportEdits(data, "原始判断", edited);

  assert.deepEqual(result.issues, []);
  assert.equal(result.focusText, "更新后的判断");
  assert.equal(result.data.funding_rates[0].rate, 1.45);
  assert.equal(result.data.funding_rates[0].change_bp, 3);
  assert.deepEqual(result.data.stock_paragraphs, ['A股主要指数震荡收涨。']);
  assert.equal(result.data.primary_issues[2].amount, 35);
  assert.deepEqual(result.data.primary_issues[2].coupons, [1.75]);
  assert.equal(result.data.primary_summary.current_amount, 155);
  assert.equal(result.data.inventory_bonds[0].valuation, 1.57);
  assert.equal(result.data.inventory_bonds[0].trade_yield, 1.58);
  assert.equal(result.data.inventory_bonds[0].trade_spread_bp, 1);
  assert.match(buildTextReport(result.data, result.focusText), /今日银行间隔夜和7天期利率全面上行/);
});

test("文字版缺少固定段落时不修改结构化数据", () => {
  const edited = buildTextReport(data, "原始判断").replace("【利率】", "利率");
  const result = applyTextReportEdits(data, "原始判断", edited);
  assert.match(result.issues.join("；"), /缺少【利率】段落/);
  assert.deepEqual(result.data, data);
});

test("文字版央行金额与利率修改回写公开市场操作数据", () => {
  const edited = buildTextReport(data, "原始判断").replace(
    "7天期逆回购1185亿元，操作利率为1.40%",
    "7天期逆回购1285亿元，操作利率为1.45%",
  );
  const result = applyTextReportEdits(data, "原始判断", edited);
  const operation = result.data.omo_operations.find(
    (row) => row.operation_date === data.report_date && row.amount_yi === 1285,
  );

  assert.deepEqual(result.issues, []);
  assert.equal(operation?.duration, "7D");
  assert.equal(operation?.operation_name, "逆回购");
  assert.equal(operation?.interest_rate, 1.45);
  assert.match(buildTextReport(result.data, result.focusText), /净投放400亿元/);
});

test("文字版派生结论不能脱离明细数据单独改写", () => {
  const edited = buildTextReport(data, "原始判断").replace(
    "今日银行间隔夜和7天期利率多数上行。",
    "今日银行间隔夜和7天期利率全面下行。",
  );
  const result = applyTextReportEdits(data, "原始判断", edited);

  assert.match(result.issues.join("；"), /【利率】未识别到可回写的数据修改/);
  assert.deepEqual(result.data, data);
});

test("同一段的数据修改与不可回写文案修改不会被部分保存", () => {
  const edited = buildTextReport(data, "原始判断")
    .replace("DR001报1.4000%，跌2.00bp", "DR001报1.4500%，涨3.00bp")
    .replace(
      "今日银行间隔夜和7天期利率多数上行。",
      "资金面较昨日明显转松。",
    );
  const result = applyTextReportEdits(data, "原始判断", edited);

  assert.match(result.issues.join("；"), /【利率】包含无法回写为数据的修改/);
  assert.deepEqual(result.data, data);
});
