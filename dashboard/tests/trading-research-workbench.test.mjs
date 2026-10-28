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

test("二级池成交明细表统一使用 1rem 字号", async () => {
  const styles = await readFile(
    new URL("../src/bond-ledger.css", import.meta.url),
    "utf8",
  );

  assert.match(
    styles,
    /\.ledger-table--transactions :is\(th, td\)\s*\{[\s\S]*?font-size:\s*1rem/,
  );
  assert.match(
    styles,
    /\.ledger-panel--risk \.ledger-return-risk-grid\s*\{[\s\S]*?align-content:\s*stretch;[\s\S]*?grid-auto-rows:\s*minmax\(0, 1fr\)/,
  );
});

test("二级债券池运营周报复用共享组件并提供独立与工作台路由", async () => {
  const [page, standaloneRoute, workbench, routeLoader, styles, charts, design] =
    await Promise.all([
      readFile(
        new URL(
          "../src/lib/pages/SecondaryBondPoolWeeklyPage.svelte",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../src/routes/secondary-bond-pool/+page.svelte",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../src/lib/trading-research/WorkbenchPage.svelte",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../src/routes/trading-research/[view]/+page.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../src/secondary-bond-pool.css", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../src/charts/bond-ledger.ts", import.meta.url), "utf8"),
      Promise.all([readFile(new URL("../DESIGN.md", import.meta.url), "utf8"), readFile(new URL("../docs/modules/secondary-bond-pool.md", import.meta.url), "utf8")]).then(parts => parts.join("\n")),
    ]);

  assert.match(page, /yearToLatestLedgerRange\(currentReportDate\(\), \[/);
  assert.match(page, /<BondLedgerUploadButton onImported=\{refreshReport\} \/>/);
  assert.doesNotMatch(page, /报告数字由最新有效交易日|本周区间按报告基准日/);
  assert.match(page, /已质押 <strong>\{formatYi\(analytics.availability.pledgedMarketValue\)\}/);
  assert.match(page, /formatYi\(analytics.availability.availableMarketValue\)/);
  assert.doesNotMatch(page, /WEEKLY_PLEDGED_AMOUNT/);
  assert.match(page, /MetricCard from "\.\.\/\.\.\/components\/MetricCard\.svelte"/);
  assert.match(page, /ModuleCard from "\.\.\/\.\.\/components\/ModuleCard\.svelte"/);
  assert.match(page, /ChartHost from "\.\.\/\.\.\/components\/ChartHost\.svelte"/);
  assert.match(page, /title="规模演变与杠杆走势"/);
  assert.match(page, /title="收益率与累计创收归因"/);
  assert.match(page, /title="资产配置与期限分布"/);
  assert.match(page, /title="核心重仓券速览"/);
  assert.match(page, /title="后续跟踪重点"/);
  assert.match(page, /use:portal=\{embedded \? "#tr-topbar-actions" : null\}/);
  assert.match(standaloneRoute, /<WorkbenchPage viewId="secondary-bond-pool" \/>/);
  assert.match(workbench, /<SecondaryBondPoolWeeklyPage embedded \/>/);
  assert.match(routeLoader, /workbenchRoutes/);
  assert.match(styles, /\.secondary-weekly-columns\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(styles, /1\.15fr|0\.85fr/);
  assert.doesNotMatch(styles, /1140px/);
  assert.doesNotMatch(styles, /min-width:\s*520px/);
  assert.match(styles, /\.secondary-weekly-table-wrap\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(page, /layout-report layout-report--secondary/);
  assert.match(styles, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(page, /variant="report"/);
  assert.match(page, /本周营收/);
  assert.match(charts, /data:\s*\["业务本金", "全池持仓市值", "时间加权本金"\][\s\S]*?left:\s*"center"/);
  assert.match(charts, /data:\s*\["全池综合杠杆率", "平层基准（100%）"\][\s\S]*?left:\s*"center"/);
  assert.match(charts, /formatter:\s*`最新持仓 \$\{\(latest\.marketValue \/ 100_000_000\)\.toFixed\(2\)\} 亿\\n本金/);
  assert.match(charts, /name:\s*"平层基准（100%）"[\s\S]*?data:\s*points\.map\(\(\) => 100\)/);
  assert.match(charts, /const SECONDARY_POOL_BLUE_SCALE = \[[\s\S]*?"#1e3a8a"[\s\S]*?"#bfdbfe"[\s\S]*?\] as const/);
  assert.match(charts, /color:\s*\n\s*SECONDARY_POOL_BLUE_SCALE\[/);
  assert.match(design, /桌面等宽双栏/);
  assert.match(design, /图 1 必须显示最新持仓与本金/);
  assert.match(design, /图 3A 使用由深到浅的蓝色渐变序列/);
});

test("版式报告统一使用 1080px A4 画布且工作台 main 不增加报告包装层", async () => {
  const [layoutStyles, workbench, secondary, financing, credit, design] =
    await Promise.all([
      readFile(new URL("../src/layout-report.css", import.meta.url), "utf8"),
      readFile(
        new URL("../src/lib/trading-research/WorkbenchPage.svelte", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/pages/SecondaryBondPoolWeeklyPage.svelte", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/pages/FinancingModelPage.svelte", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../src/lib/trading-research/CreditView.svelte", import.meta.url),
        "utf8",
      ),
      Promise.all([readFile(new URL("../DESIGN.md", import.meta.url), "utf8"), readFile(new URL("../docs/modules/secondary-bond-pool.md", import.meta.url), "utf8")]).then(parts => parts.join("\n")),
    ]);

  assert.match(layoutStyles, /\.layout-report\s*\{[\s\S]*max-width:\s*1080px/);
  assert.match(layoutStyles, /@page\s*\{[\s\S]*size:\s*A4 portrait;[\s\S]*margin:\s*0/);
  const printRules = layoutStyles.slice(layoutStyles.indexOf("@media print"));
  assert.match(printRules, /\.layout-report\s*\{[\s\S]*width:\s*1080px !important/);
  assert.match(printRules, /zoom:\s*0\.734908136/);
  assert.match(printRules, /> :not\(\.layout-report\):not\(:has\(\.layout-report\)\)/);
  assert.match(layoutStyles, /\.layout-report table\s*\{[\s\S]*min-width:\s*0 !important;[\s\S]*table-layout:\s*auto/);
  assert.match(layoutStyles, /\.layout-report table :is\(th, td\)\s*\{[\s\S]*width:\s*auto !important;[\s\S]*white-space:\s*normal !important;[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(layoutStyles, /\.layout-report table :is\(th, td\) > \*\s*\{[\s\S]*min-width:\s*0 !important;[\s\S]*max-width:\s*100% !important/);
  assert.match(layoutStyles, /\.layout-report :is\([^}]+\)\s*\{[\s\S]*max-height:\s*none !important;[\s\S]*overflow:\s*visible !important/);

  const sharedShell = await readFile(new URL("../src/lib/workbench/WorkbenchShell.svelte", import.meta.url), "utf8");
  assert.match(sharedShell, /<main\s+[\s\S]*id="tr-workbench-main"/);
  assert.doesNotMatch(sharedShell, /role="main"/);
  assert.match(workbench, /layoutReport=\{isLayoutReport\(activeViewId\)\}/);
  assert.match(sharedShell, /class:layout-report=\{layoutReport\}/);
  assert.doesNotMatch(secondary, /secondary-weekly-shell/);
  assert.doesNotMatch(secondary, /<article[^>]+secondary-weekly-report/);
  assert.match(secondary, /<main[\s\S]*layout-report layout-report--secondary/);
  assert.doesNotMatch(financing, /<div[^>]+financing-model-page/);
  assert.match(financing, /<main class="financing-model-page layout-report layout-report--financing">/);
  assert.match(credit, /tr-credit-weekly-report layout-report layout-report--credit/);
  assert.match(design, /授信周报、二级债券池运营周报和融资择时模型报告统一视为版式报告/);
  assert.match(design, /所有表格使用内容驱动的自适应列宽/);
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
