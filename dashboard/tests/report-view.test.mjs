import assert from "node:assert/strict";
import test from "node:test";

import {
  comparablePoints,
  deriveReport,
  fundMetrics,
  governmentBondMetrics,
  inventoryPoints,
  marginSnapshot,
  omoHistoryPoints,
  primaryPoints,
} from "../src/report-view.ts";

const emptyMargin = {
  data_date: null,
  total: null,
  total_change: null,
  financing: null,
  financing_change: null,
  securities_lending: null,
  securities_lending_change: null,
};

test("OMO 规范记录按日聚合为最近十个操作日净投放", () => {
  const points = omoHistoryPoints([
    { operation_date: "2026-08-10", operation_name: "逆回购", duration: "7D", amount_yi: 100, interest_rate: 1.4 },
    { operation_date: "2026-08-11", operation_name: "逆回购", duration: "7D", amount_yi: -50, interest_rate: 1.4 },
    { operation_date: "2026-08-11", operation_name: "逆回购", duration: "14D", amount_yi: 200, interest_rate: null },
  ]);
  assert.deepEqual(points, [
    { day: "2026-08-10", net_amount: 100 },
    { day: "2026-08-11", net_amount: 150 },
  ]);
});

test("资金面指标直接投影 API 规范字段", () => {
  assert.deepEqual(fundMetrics([
    { code: "DR001", rate: 1.4, change_bp: -2 },
    { code: "DR007", rate: 1.5, change_bp: 0 },
    { code: "DIBO001", rate: 1.7, change_bp: 1 },
    { code: "DIBO007", rate: 1.8, change_bp: 2 },
  ]), [
    { label: "DR001", value: 1.4, change: -2, unit: "%" },
    { label: "DR007", value: 1.5, change: 0, unit: "%" },
    { label: "DIBO001", value: 1.7, change: 1, unit: "%" },
    { label: "DIBO007", value: 1.8, change: 2, unit: "%" },
  ]);
});

test("关键期限国债收益率直接使用共享加工层已选成交券", () => {
  assert.deepEqual(governmentBondMetrics([
    { category: "国债", tenor: "1Y", code: "1", yield_rate: 1.4, change_bp: 2 },
    { category: "国债", tenor: "10Y", code: "10", yield_rate: 1.8, change_bp: -1 },
    { category: "国债", tenor: "超长期限", code: "30", yield_rate: 2, change_bp: 0 },
  ]), [
    { label: "1Y国债", value: 1.4, change: 2, unit: "%" },
    { label: "5Y国债", value: null, change: null, unit: "%" },
    { label: "10Y国债", value: 1.8, change: -1, unit: "%" },
    { label: "30Y国债", value: 2, change: 0, unit: "%" },
  ]);
});

test("融资融券快照不再暴露上游编码", () => {
  const snapshot = { ...emptyMargin, data_date: "2026-08-12", total: 21000.5, total_change: 100.5 };
  assert.deepEqual(marginSnapshot(snapshot), snapshot);
  assert.equal("TOTAL_RZRQYE" in snapshot, false);
});

test("一级发行保留共享加工层规范后的票息空值", () => {
  const points = primaryPoints([{ issue_date: "08/10", issue_date_key: "2026-08-10", issuer: "丙", category: "小公募", bond_names: ["26无票面01"], tenors: ["2年"], coupons: [null], amount: 10 }]);
  assert.deepEqual(points[0].coupons, [null]);
});

test("一级发行列表不再包含被共享加工层排除的东方财富条目", () => {
  const points = primaryPoints([{ issue_date: "08/13", issue_date_key: "2026-08-13", issuer: "东莞证券", category: "小公募", bond_names: ["26东莞03"], tenors: ["2年"], coupons: [1.65], amount: 20 }]);
  assert.deepEqual(points.flatMap((point) => point.bond_names), ["26东莞03"]);
});

test("一级发行保持共享加工层合并后的腿顺序和金额", () => {
  const points = primaryPoints([{ issue_date: "08/18", issue_date_key: "2026-08-18", issuer: "甲证券", category: "小公募", bond_names: ["26甲01", "26甲02"], tenors: ["3年", "5年"], coupons: [1.86, 2.28], amount: 32.4 }]);
  assert.deepEqual(points[0], { issue_date: "08/18", issue_date_key: "2026-08-18", issuer: "甲证券", category: "小公募", bond_names: ["26甲01", "26甲02"], tenors: ["3年", "5年"], coupons: [1.86, 2.28], amount: 32.4 });
});

test("可比债券视图只消费共享加工层已筛选的公募券", () => {
  const points = comparablePoints([{ bond_id: "2", bond_name: "25券商01", issuer: "国投证券", tenor_label: "0.8Y", tenor_years: 0.8, valuation: 1.41, trade_yield: 1.42 }]);
  assert.deepEqual(points, [{ bond_name: "25券商01", issuer: "国投证券", tenor_years: 0.8, trade_yield: 1.42 }]);
});

test("可比债券投影不恢复上游发行人编码", () => {
  const points = comparablePoints([{ bond_id: "2", bond_name: "25券商01", issuer: "国投证券", tenor_label: "1.1Y", tenor_years: 1.1, valuation: 1.41, trade_yield: 1.42 }]);
  assert.equal(points[0].issuer, "国投证券");
});

test("可比债券继续用稳健残差过滤离群点", () => {
  const samples = [[0.1,1.43],[0.6,1.48],[1.1,1.5],[1.7,1.56],[1.8,1.87],[1.9,2.45],[2.4,1.6],[3,1.66],[3.7,1.71],[4.9,1.75]];
  const points = comparablePoints(samples.map(([tenor, trade], index) => ({ bond_id: String(index), bond_name: `债券${index}`, issuer: "甲", tenor_label: `${tenor}Y`, tenor_years: tenor, valuation: trade, trade_yield: trade })));
  assert.deepEqual(points.map((point) => point.bond_name), ["债券0","债券1","债券2","债券3","债券6","债券7","债券8","债券9"]);
});

test("存量债按规范期限排序并保留成交和报价", () => {
  const points = inventoryPoints([
    { bond_name: "25东财G1", tenor_label: "1Y", tenor_years: 1, valuation: 1.7, trade_yield: null, trade_spread_bp: null, bid_yield: 1.71, ofr_yield: 1.69 },
    { bond_name: "25东财G2", tenor_label: "0.5Y", tenor_years: 0.5, valuation: 1.6, trade_yield: 1.61, trade_spread_bp: 1, bid_yield: null, ofr_yield: null },
  ]);
  assert.equal(points[0].bond_name, "25东财G2");
  assert.equal(points[1].bid_yield, 1.71);
});

test("存量债零 Bid/Ofr 在视觉派生层转为空值", () => {
  const points = inventoryPoints([
    { bond_name: "25东财G1", tenor_label: "1Y", tenor_years: 1, valuation: 1.7, trade_yield: null, trade_spread_bp: null, bid_yield: 0, ofr_yield: 0 },
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].bond_name, "25东财G1");
  assert.equal(points[0].bid_yield, null);
  assert.equal(points[0].ofr_yield, null);
});

test("deriveReport 从最小契约产出全部派生视图", () => {
  const derived = deriveReport({
    report_date: "2026-08-13", generated_at: "2026-08-13T15:00:00+08:00",
    omo_operations: [{ operation_date: "2026-08-13", operation_name: "逆回购", duration: "7D", amount_yi: 100, interest_rate: 1.4 }],
    funding_rates: [], government_bonds: [], futures: [], stock_paragraphs: [], margin: emptyMargin,
    equities: [], equity_data_time: null, turnover_yi: null, turnover_change_yi: null,
    industries: [], industry_data_date: "2026-08-13", primary_summary: { current_amount: 0, change_amount: null },
    primary_issues: [], secondary_bonds: [], inventory_bonds: [],
  });
  assert.deepEqual(derived.omoHistory, [{ day: "2026-08-13", net_amount: 100 }]);
  assert.equal(derived.funds.length, 4);
  assert.equal(derived.governmentBonds.length, 4);
  assert.deepEqual(derived.margin, emptyMargin);
});
