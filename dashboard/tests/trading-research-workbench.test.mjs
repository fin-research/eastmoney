import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  computeTradingSummary,
  demoTrades,
  normalizeWorkbenchView,
  workbenchViewPath,
  workbenchRoutes,
  workbenchViews,
} from "../src/lib/trading-research/demo-data.ts";
import {
  ALL_ECONOMIC_INDICATORS,
  ECONOMIC_INDICATOR_GROUPS,
  LIABILITY_REPORT_RATE_INDICATORS,
  LIQUIDITY_RATE_INDICATORS,
  economicIndicatorChange,
  economicIndicatorRange,
  formatEconomicDataRefresh,
  formatEconomicIndicatorChange,
  formatEconomicIndicatorTooltip,
  mapEconomicIndicatorRows,
  mapLiquidityRateRows,
} from "../src/lib/trading-research/economic-indicators.ts";

test("交易研究工作台将交易流程归入交易管理并保留流程深链", () => {
  assert.deepEqual(
    workbenchViews.map((view) => view.label),
    [
      "总览",
      "交易管理",
      "市场热点",
      "政策跟踪",
      "跟踪点评",
      "研究辅助",
      "二级池周报",
      "融资择时模型",
    ],
  );
  assert.equal(normalizeWorkbenchView("market-hotspots"), "market-hotspots");
  assert.equal(normalizeWorkbenchView("policy-tracking"), "policy-tracking");
  assert.equal(normalizeWorkbenchView("credit"), "overview");
  assert.equal(normalizeWorkbenchView("bond"), "bond");
  assert.equal(normalizeWorkbenchView("secondary-bond-pool"), "secondary-bond-pool");
  assert.equal(normalizeWorkbenchView("financing-model"), "financing-model");
  assert.equal(normalizeWorkbenchView("timing"), "overview");
  assert.equal(normalizeWorkbenchView(null), "overview");
  assert.equal(workbenchViewPath("overview"), "/trading-research");
  assert.equal(workbenchViewPath("bond"), "/trading-research/bond");
  assert.equal(workbenchViewPath("workflow"), "/trading-research/workflow");
  assert.equal(
    workbenchViewPath("secondary-bond-pool"),
    "/trading-research/secondary-bond-pool",
  );
  assert.ok(workbenchRoutes.some((view) => view.id === "bond"));
  assert.ok(workbenchRoutes.some((view) => view.id === "workflow"));
  assert.ok(!workbenchViews.some((view) => view.id === "bond"));
  assert.ok(!workbenchViews.some((view) => view.id === "workflow"));
  assert.equal(
    workbenchViewPath("financing-model"),
    "/trading-research/financing-model",
  );
});

test("演示交易汇总严格由迁入的十笔交易派生", () => {
  const summary = computeTradingSummary(demoTrades);
  assert.equal(summary.tradeCount, 10);
  assert.equal(summary.totalAmount, 45);
  assert.equal(summary.interbankAmount, 27.5);
  assert.equal(summary.repoLendAmount, 17.5);
  assert.equal(summary.pendingCount, 2);
  assert.equal(Number(summary.weightedRate.toFixed(4)), 1.8358);
});

test("经济指标按九类四项配置并应用必要口径换算", () => {
  assert.equal(ECONOMIC_INDICATOR_GROUPS.length, 9);
  assert.ok(
    ECONOMIC_INDICATOR_GROUPS.every((group) => group.indicators.length === 4),
  );
  assert.equal(
    new Set(
      ECONOMIC_INDICATOR_GROUPS.flatMap((group) =>
        group.indicators.map((indicator) => indicator.code),
      ),
    ).size,
    36,
  );
  assert.deepEqual(
    ECONOMIC_INDICATOR_GROUPS.map((group) => group.type),
    [
      "增长与景气",
      "需求",
      "价格",
      "货币与信用",
      "高频指标",
      "海外基本面",
      "海外利率",
      "汇率与商品",
      "全球风险资产",
    ],
  );

  const groups = mapEconomicIndicatorRows([
    { code: "EMI01737210", date: "2026-07-31", value: 101.8 },
    { code: "EMG01339436", date: "2026-08-27", value: -0.12 },
  ]);
  assert.equal(Number(groups[2].indicators[1].points[0].value.toFixed(1)), 1.8);
  assert.equal(groups[6].indicators[3].points[0].value, -12);
  assert.deepEqual(economicIndicatorRange(new Date("2026-08-28T08:00:00Z")), {
    startDate: "2025-02-01",
    endDate: "2026-08-28",
  });
  assert.equal(ECONOMIC_INDICATOR_GROUPS[0].indicators[0].frequency, "季频");
  assert.equal(ECONOMIC_INDICATOR_GROUPS[0].indicators[1].frequency, "月频");
  assert.equal(ECONOMIC_INDICATOR_GROUPS[4].indicators[0].frequency, "日频");
  assert.equal(ECONOMIC_INDICATOR_GROUPS[6].indicators[0].frequency, "不定期");
  assert.equal(
    formatEconomicDataRefresh("2026-08-28T07:56:59.532Z"),
    "2026-08-28 15:56",
  );
  assert.equal(
    economicIndicatorChange([
      { date: "2026-07-01", value: 2.4 },
      { date: "2026-08-01", value: 2.7 },
    ]),
    0.30000000000000027,
  );
  assert.equal(formatEconomicIndicatorChange(0.30000000000000027, 1), "+0.3");
  assert.equal(formatEconomicIndicatorChange(-12, 0), "-12");
  assert.equal(formatEconomicIndicatorChange(null, 1), "—");
});

test("利率与资金面使用核验后的 EDB ID 并保留完整日频对齐窗口", () => {
  assert.deepEqual(
    Object.fromEntries(
      LIQUIDITY_RATE_INDICATORS.map((indicator) => [
        indicator.name,
        indicator.code,
      ]),
    ),
    {
      "7D逆回购利率": "E1715081",
      DR001: "E1300003",
      DR007: "E1300004",
      R007: "E1704420",
      "1Y AAA NCD": "E1713049",
      "1Y国债": "E1000172",
      "10Y国债": "E1000180",
      "30Y国债": "E1000183",
    },
  );
  const rates = mapLiquidityRateRows([
    { code: "E1300004", date: "2026-08-29", value: 1.4 },
    { code: "E1300004", date: "2026-08-31", value: "1.45" },
  ]);
  assert.deepEqual(rates.find((series) => series.key === "dr007").points, [
    { date: "2026-08-29", value: 1.4 },
    { date: "2026-08-31", value: 1.45 },
  ]);
});

test("负债周报利率指标进入统一 public.edb 定时同步清单", () => {
  assert.deepEqual(
    LIABILITY_REPORT_RATE_INDICATORS.map((indicator) => indicator.code),
    [
      "E1707781", "E1707782", "E1707783", "E1707785",
      "E1000172", "E1000174", "E1000176",
      "E1704281", "E1704282", "E1704283", "E1704284",
    ],
  );
  assert.equal(new Set(ALL_ECONOMIC_INDICATORS.map((indicator) => indicator.code)).size, 60);
});

test("经济指标 tooltip 只显示发布日期和数值", () => {
  const tooltip = formatEconomicIndicatorTooltip(
    [{ axisValueLabel: "2026-08-28", data: 4.2, seriesName: "GDP不变价同比" }],
    "%",
    1,
  );
  assert.match(tooltip, /2026-08-28/);
  assert.match(tooltip, /4\.2 %/);
  assert.doesNotMatch(tooltip, /GDP不变价同比/);
});

// Architecture guard only. Appearance and layout belong to tests/visual.
test("普通工作台模块继续复用共享卡片", async () => {
  for (const file of [
    "trading-research/OverviewView.svelte",
    "trading-research/TradingView.svelte",
    "trading-research/CreditView.svelte",
    "pages/BondLedgerPage.svelte",
    "pages/FinancingModelPage.svelte",
  ]) {
    const source = await readFile(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    assert.match(source, /<MetricCard\b/, `${file} uses the shared metric card`);
    assert.match(source, /<ModuleCard\b/, `${file} uses the shared module card`);
  }
});
