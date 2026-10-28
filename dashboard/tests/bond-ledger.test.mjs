import assert from "node:assert/strict";
import test from "node:test";

import { utils, write } from "xlsx";

import {
  buildBondLedgerAnalytics,
  buildAccountPerformanceTrends,
  buildOperatingTrend,
  calculateBusinessAnnualizedReturn,
  calculateBusinessAnnualizedReturnTrend,
  calculateReturnRiskMetrics,
  isoWeek,
  previousBusinessWeekRange,
  weekRange,
} from "../src/lib/bond-ledger/analytics.ts";
import {
  calendarDays,
  calendarDaysWithLedgerStatus,
  resolveAvailableRange,
  shiftMonth,
} from "../src/lib/bond-ledger/calendar.ts";
import {
  BondLedgerParseError,
  parseBondLedgerBuffer,
  parseBondLedgerMatrices,
} from "../src/lib/bond-ledger/parser.ts";
import {
  archiveBondLedgerRequest,
  bondLedgerObjectKey,
  BondLedgerUploadError,
  getBondLedgerFile,
} from "../src/lib/server/bond-ledger.ts";
import {
  listBondLedgerInventory,
  persistParsedBondLedger,
} from "../src/lib/server/bond-ledger-repository.ts";
import { parsedBondLedgerSchema } from "../src/lib/bond-ledger/import-schema.ts";
import { GET as redirectLegacyBondLedger } from "../src/routes/bond-ledger/+server.ts";
import {
  readPreferences,
  savePreferences,
} from "../src/lib/preferences.ts";

const POSITION_HEADERS = [
  "报表日期",
  "团队",
  "投资经理",
  "账户",
  "债券代码",
  "交易市场",
  "债券名称",
  "债券分类",
  "收益率变动(BP)",
  "剩余期限（年）",
  "起息日",
  "到期日",
  "今日持仓量",
  "昨日持仓量",
  "当日买量",
  "当日卖量",
  "当日到期量",
  "票面利率",
  "今日估值收益率",
  "含免税报表收益率",
  "估值全价",
  "DV01",
  "全价市值",
  "票息收入",
  "免税收入",
  "资本利得",
  "当日损益",
  "全年损益",
  "全价成本",
];

test("解析标准台账前两张表并统一日期与数值", () => {
  const header = Array(47).fill(null);
  header[0] = "日期";
  header[2] = "业务本金";
  header[9] = "持仓规模";
  header[12] = "杠杆率";
  header[19] = "修正久期";
  const performance = Array(47).fill(null);
  performance[0] = "2026/08/20";
  performance[2] = 6_500_000_000;
  performance[5] = 4_500_000_000;
  performance[9] = 6_400_000_000;
  performance[12] = 0.985;
  performance[19] = 1.46;
  performance[20] = 380_000;
  performance[30] = 71_000_000;
  performance[36] = 0.0245;
  performance[37] = 0.0241;
  performance[42] = 0.0229;
  performance[43] = 0.0225;
  const cachedFuturePerformance = [...performance];
  cachedFuturePerformance[0] = "2026/08/21";
  const position = Array(29).fill(null);
  position[0] = "2026/8/20";
  position[4] = "260306.IB";
  position[5] = "银行间";
  position[6] = "26进出06";
  position[7] = "政策性银行债";
  position[8] = -0.5;
  position[9] = 2.3;
  position[11] = "2028/12/1";
  position[12] = 11_000_000;
  position[14] = 11_000_000;
  position[19] = 1.43;
  position[21] = 30_000;
  position[22] = 1_100_000_000;
  position[25] = -3400.000000000342;
  position[26] = 50_000;
  position[27] = 500_000;

  const result = parseBondLedgerMatrices(
    [
      header,
      Array(47).fill(null),
      ["2026/01/01", null, 1, null, null, null, null, null, null, 1],
      performance,
      cachedFuturePerformance,
    ],
    [POSITION_HEADERS, position],
  );

  assert.equal(result.date, "2026-08-20");
  assert.deepEqual(result.performance.map((row) => row.date), ["2026-08-20"]);
  assert.equal(result.performance[0].marketValue, 6_400_000_000);
  assert.equal(result.performance[0].ytdAnnualizedReturn, 0.0245);
  assert.equal(result.performance[0].ytdExTaxAnnualizedReturn, 0.0229);
  assert.equal(result.positions[0].buyQuantity, 11_000_000);
  assert.equal(result.positions[0].reportYield, 1.43);
  assert.equal(result.positions[0].realizedProfit, -3400.000000000342);
});

test("按表名合并交易户和可供户并统一派生成交", async () => {
  const performanceHeader = Array(47).fill(null);
  performanceHeader[0] = "日期";
  performanceHeader[2] = "业务本金";
  performanceHeader[9] = "持仓规模";
  performanceHeader[12] = "杠杆率";
  performanceHeader[19] = "修正久期";
  const performance = Array(47).fill(null);
  performance[0] = "2026/08/27";
  performance[2] = 652_023_900;
  performance[5] = 652_023_900;
  performance[9] = 632_695_500;
  performance[12] = 1;
  performance[19] = 1.5;

  const transactionPosition = positionMatrixRow(POSITION_HEADERS, {
    报表日期: "2026/08/27",
    账户: "财务资金-交易户",
    债券代码: "260306.IB",
    交易市场: "银行间",
    债券名称: "26进出06",
    债券分类: "政策性银行债",
    "收益率变动(BP)": 0,
    "剩余期限（年）": 2.3,
    到期日: "2028/12/1",
    今日持仓量: 1_000_000,
    昨日持仓量: 1_000_000,
    当日买量: 0,
    当日卖量: 0,
    当日到期量: 0,
    票面利率: 2,
    今日估值收益率: 1.4,
    含免税报表收益率: 1.4,
    估值全价: 100,
    DV01: 10_000,
    全价市值: 100_000_000,
    当日损益: 0,
    全年损益: 0,
    全价成本: 100,
  });
  const availableHeaders = POSITION_HEADERS.filter(
    (header) =>
      !["收益率变动(BP)", "今日估值收益率", "DV01"].includes(header),
  );
  const availablePosition = positionMatrixRow(availableHeaders, {
    报表日期: "2026/08/27",
    账户: "财务资金-可供户",
    债券代码: "220021.IB",
    交易市场: "银行间",
    债券名称: "22附息国债21",
    债券分类: "国债",
    "剩余期限（年）": 3.0795,
    到期日: "2029/9/25",
    今日持仓量: 5_000_000,
    昨日持仓量: 0,
    当日买量: 5_000_000,
    当日卖量: 0,
    当日到期量: 0,
    票面利率: 2.62,
    含免税报表收益率: 1.63446753122,
    估值全价: 106.5319,
    全价市值: 532_695_500,
    当日损益: -151_360.9688839832,
    全年损益: -151_360.9688839832,
    全价成本: 106.570435616,
  });
  const workbook = utils.book_new();
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet([
      performanceHeader,
      Array(47).fill(null),
      ["2026/01/01", null, 1, null, null, null, null, null, null, 1],
      performance,
    ]),
    "二级池累计收益",
  );
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet([POSITION_HEADERS, transactionPosition]),
    "当日交易户数据",
  );
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet([availableHeaders, availablePosition]),
    "当日可供户数据 ",
  );

  const parsed = await parseBondLedgerBuffer(
    write(workbook, { type: "buffer", bookType: "xlsx" }),
  );
  const analytics = buildBondLedgerAnalytics(
    [parsed],
    "2026-08-27",
    "2026-08-27",
  );

  assert.deepEqual(parsedBondLedgerSchema.parse(parsed), parsed);
  assert.equal(parsed.positions.length, 2);
  assert.deepEqual(parsed.positions.map((row) => row.rowNumber), [1, 2]);
  assert.deepEqual(parsed.positions.map((row) => row.account), [
    "财务资金-交易户",
    "财务资金-可供户",
  ]);
  assert.equal(parsed.positions[1].buyQuantity, 5_000_000);
  assert.equal(parsed.positions[1].yieldChangeBp, null);
  assert.equal(parsed.positions[1].valuationYield, null);
  assert.equal(parsed.positions[1].dv01, 0);
  assert.equal(analytics.transactionTotals.买入, 500_000_000);
  assert.equal(analytics.detailMarketValue, 632_695_500);
  assert.equal(analytics.reconciliationGap, 0);
});

test("拒绝缺少标准字段的台账", () => {
  assert.throws(
    () => parseBondLedgerMatrices([["日期"]], [["报表日期"]]),
    (error) =>
      error instanceof BondLedgerParseError &&
      error.message.includes("业务本金"),
  );
});

test("区间收益、类型加权收益率与成交方向统一派生", () => {
  const before = performanceRow("2026-08-14", 100, 1_000);
  const monday = performanceRow("2026-08-17", 110, 1_000);
  const tuesday = performanceRow("2026-08-18", 130, 1_000);
  const ledger17 = ledger("2026-08-17", [before, monday], [
    positionRow({ code: "BOND-1", category: "国债", marketValue: 100, reportYield: 1, buyQuantity: 2 }),
  ]);
  const ledger18 = ledger("2026-08-18", [before, monday, tuesday], [
    positionRow({ code: "BOND-1", category: "国债", marketValue: 300, reportYield: 3, sellQuantity: 3 }),
    positionRow({ code: "BOND-2", category: "债券ETF", marketValue: 200, reportYield: 0 }),
  ]);

  const result = buildBondLedgerAnalytics(
    [ledger17, ledger18],
    "2026-08-17",
    "2026-08-18",
  );

  assert.equal(result.rangeProfit, 30);
  assert.equal(result.rangeAnnualizedReturn, (30 / 1_000) * (365 / 2));
  assert.equal(result.holdingTypes[0].category, "国债");
  assert.equal(result.holdingTypes[0].weightedYield, 3);
  assert.equal(result.holdingTypes[1].weightedYield, null);
  assert.equal(result.maturityBuckets.length, 8);
  assert.equal(result.currentPositions[0].rangeProfit, 2);
  assert.deepEqual(
    result.transactions.map(({ side, faceAmount }) => ({ side, faceAmount })),
    [
      { side: "卖出", faceAmount: 300 },
      { side: "买入", faceAmount: 200 },
    ],
  );
});

test("业务收益率按交易日单日收益率算术平均乘 252 年化", () => {
  const monday = performanceRow("2026-08-17", 0, 1_000);
  monday.dailyRevenue = 0.08;
  const tuesday = performanceRow("2026-08-18", 0, 2_000);
  tuesday.dailyRevenue = 0.2511111111111111;
  const performance = [monday, tuesday];
  const expected = ((0.08 / 1_000 + 0.2511111111111111 / 2_000) / 2) * 252;

  assert.ok(
    Math.abs(calculateBusinessAnnualizedReturn(performance) - expected) < 1e-12,
  );
  assert.equal(Number((expected * 100).toFixed(2)), 2.59);
  assert.deepEqual(
    calculateBusinessAnnualizedReturnTrend(performance).map(({ value }) => value),
    [0.00008 * 252, expected],
  );
  assert.deepEqual(weekRange("2026-08-20"), {
    startDate: "2026-08-17",
    endDate: "2026-08-20",
  });
  assert.deepEqual(previousBusinessWeekRange("2026-09-01"), {
    startDate: "2026-08-24",
    endDate: "2026-08-28",
  });
});

test("运营周报按全池口径派生免税增厚、平层静态与双户结构", () => {
  const first = performanceRow("2026-01-05", 100, 1_000);
  first.timeWeightedPrincipal = 1_000;
  first.ytdAnnualizedReturn = (100 / 1_000) * (365 / 4);
  first.ytdExTaxAnnualizedReturn = (90 / 1_000) * (365 / 4);
  const second = performanceRow("2026-01-06", 160, 1_000);
  second.timeWeightedPrincipal = 1_000;
  second.ytdAnnualizedReturn = (160 / 1_000) * (365 / 5);
  second.ytdExTaxAnnualizedReturn = (130 / 1_000) * (365 / 5);
  const third = performanceRow("2026-01-07", 180, 1_000);
  third.timeWeightedPrincipal = 1_000;
  third.dailyRevenue = 20;
  third.ytdAnnualizedReturn = 0.1;
  third.ytdExTaxAnnualizedReturn = 0.09;
  const summaries = [
    accountSummary("2026-01-05", "交易户", 800, 10, 100, 1.4),
    accountSummary("2026-01-05", "可供户", 200, 0, 50, 1.8),
    accountSummary("2026-01-06", "交易户", 800, 15, 100, 1.4),
    accountSummary("2026-01-06", "可供户", 200, 5, 50, 1.8),
    accountSummary("2026-01-07", "交易户", 800, 3, 100, 1.4),
    accountSummary("2026-01-07", "可供户", 200, 1, 50, 1.8),
  ];

  const trend = buildOperatingTrend([first, second, third], summaries);

  assert.equal(trend[1].tradingMarketValue, 800);
  assert.equal(trend[1].availableMarketValue, 200);
  assert.equal(trend[1].dv01, 150);
  assert.equal(trend[1].flatStatic, 1.48);
  assert.equal(trend[1].cumulativeTaxExemptProfit, 30);
  assert.equal(trend[1].cumulativeExTaxProfit, 130);
  assert.equal(trend[1].fullPoolYtdAnnualizedReturn, second.ytdAnnualizedReturn);
  assert.equal(
    trend[1].fullPoolYtdExTaxAnnualizedReturn,
    second.ytdExTaxAnnualizedReturn,
  );
  assert.equal(trend[2].cumulativeExTaxProfit, 146);
  assert.equal(trend[2].cumulativeTaxExemptProfit, 34);
  assert.deepEqual(isoWeek("2026-08-28"), { year: 2026, week: 35 });
});

test("收益与风险指标按所选区间有效日收益率统一派生", () => {
  const before = performanceRow("2026-08-14", 0, 1_000);
  before.dailyRevenue = 500;
  const monday = performanceRow("2026-08-17", 0, 1_000);
  monday.dailyRevenue = 10;
  const tuesday = performanceRow("2026-08-18", 0, 1_000);
  tuesday.dailyRevenue = -10;
  const wednesday = performanceRow("2026-08-19", 0, 1_000);
  wednesday.dailyRevenue = 20;

  const metrics = calculateReturnRiskMetrics(
    [before, monday, tuesday, wednesday],
    "2026-08-17",
    "2026-08-19",
  );
  const dailyReturns = [0.01, -0.01, 0.02];
  const mean = dailyReturns.reduce((total, value) => total + value, 0) / 3;
  const sampleVolatility = Math.sqrt(
    dailyReturns.reduce(
      (total, value) => total + (value - mean) ** 2,
      0,
    ) / 2,
  );

  assert.ok(
    Math.abs(metrics.annualizedVolatility - sampleVolatility * Math.sqrt(252)) <
      1e-12,
  );
  assert.ok(Math.abs(metrics.maxDrawdown - 0.01) < 1e-12);
  assert.equal(metrics.validDayCount, 3);
  assert.equal(metrics.maxDrawdownPeakDate, "2026-08-17");
  assert.equal(metrics.maxDrawdownTroughDate, "2026-08-18");
});

test("收益率与波动率较上周变动采用向前七天的同口径比较", () => {
  const rows = [
    performanceRow("2026-08-10", 0, 1_000),
    performanceRow("2026-08-11", 0, 1_000),
    performanceRow("2026-08-12", 0, 1_000),
    performanceRow("2026-08-17", 0, 1_000),
    performanceRow("2026-08-18", 0, 1_000),
    performanceRow("2026-08-19", 0, 1_000),
  ];
  [10, -10, 10, 20, -20, 20].forEach((dailyRevenue, index) => {
    rows[index].dailyRevenue = dailyRevenue;
  });
  rows[2].ytdAnnualizedReturn = 0.02;
  rows[2].ytdExTaxAnnualizedReturn = 0.018;
  rows[5].ytdAnnualizedReturn = 0.023;
  rows[5].ytdExTaxAnnualizedReturn = 0.019;

  const analytics = buildBondLedgerAnalytics(
    [ledger("2026-08-19", rows, [positionRow()])],
    "2026-08-17",
    "2026-08-19",
  );
  const currentVolatility = calculateReturnRiskMetrics(
    rows,
    "2026-08-17",
    "2026-08-19",
  ).annualizedVolatility;
  const previousVolatility = calculateReturnRiskMetrics(
    rows,
    "2026-08-10",
    "2026-08-12",
  ).annualizedVolatility;

  assert.equal(typeof currentVolatility, "number");
  assert.equal(typeof previousVolatility, "number");
  assert.equal(typeof analytics.metricDeltas.annualizedVolatility, "number");
  assert.ok(
    Math.abs(analytics.metricDeltas.reportedYtdAnnualizedReturn - 0.003) <
      1e-12,
  );
  assert.ok(
    Math.abs(analytics.metricDeltas.reportedYtdExTaxAnnualizedReturn - 0.001) <
      1e-12,
  );
  assert.ok(
    Math.abs(
      analytics.metricDeltas.annualizedVolatility -
        (currentVolatility - previousVolatility),
    ) < 1e-12,
  );
});

test("规模收益走势按交易户和可供户拆分且收益贡献可加总", () => {
  const monday = performanceRow("2026-08-24", 0, 1_000);
  monday.marketValue = 1_100;
  monday.dailyRevenue = 10;
  const tuesday = performanceRow("2026-08-25", 0, 1_000);
  tuesday.marketValue = 1_300;
  tuesday.dailyRevenue = 5;
  const trends = buildAccountPerformanceTrends(
    [monday, tuesday],
    [
      ledger("2026-08-24", [monday], [
        positionRow({ account: "财务资金-交易户", marketValue: 1_100, dailyProfit: 10 }),
      ]),
      ledger("2026-08-25", [monday, tuesday], [
        positionRow({ account: "财务资金-交易户", marketValue: 900, dailyProfit: 3 }),
        positionRow({ account: "财务资金-可供户", marketValue: 400, dailyProfit: 2 }),
      ]),
    ],
  );

  assert.deepEqual(trends.trading, [
    { date: "2026-08-24", principal: 1_000, marketValue: 1_100, dailyRevenue: 10 },
    { date: "2026-08-25", principal: 1_000, marketValue: 900, dailyRevenue: 3 },
  ]);
  assert.deepEqual(trends.available, [
    { date: "2026-08-24", principal: 1_000, marketValue: 0, dailyRevenue: 0 },
    { date: "2026-08-25", principal: 1_000, marketValue: 400, dailyRevenue: 2 },
  ]);
  assert.equal(
    trends.trading[1].dailyRevenue + trends.available[1].dailyRevenue,
    tuesday.dailyRevenue,
  );
});

test("本地解析结果校验后归档原件并等待数据库提交", async () => {
  const calls = [];
  const bucket = { async put(key, body, options) {
    calls.push("archive");
    assert.match(key, /^bond-ledger\/imports\/[0-9a-f-]{36}\.xlsx$/);
    assert.equal(await new Response(body).text(), "xlsx-bytes");
    assert.equal(options.customMetadata.reportDate, "2026-08-20");
    return { key, etag: "etag-test" };
  } };
  let finish;
  const committing = new Promise(resolve => { finish = resolve; });
  const result = { reportDate: "2026-08-20", statisticsCount: 1, positionCount: 0, transactionCount: 0 };
  const pending = archiveBondLedgerRequest(uploadRequest(), bucket, async input => {
    calls.push("persist");
    assert.equal(input.parsed.performance[0].principal, 100);
    assert.equal(input.originalName, "台账.xlsx");
    await committing;
    return result;
  });
  finish();
  assert.deepEqual(await pending, result);
  assert.deepEqual(calls, ["archive", "persist"]);
});

test("无效结构、跨日持仓、重复统计与错误替换日期在写入前拒绝", async () => {
  const valid = { date: "2026-08-20", performance: [performanceRow("2026-08-20", 1, 100)], positions: [{ ...positionRow(), reportDate: "2026-08-20" }] };
  const invalid = [
    {}, { ...valid, performance: [] }, { ...valid, positions: [] },
    { ...valid, positions: [{ ...positionRow(), reportDate: valid.date, code: "", name: "" }] },
    { ...valid, positions: [{ ...positionRow(), reportDate: valid.date, currentQuantity: -1 }] },
    { ...valid, positions: [positionRow()] },
    { ...valid, performance: [...valid.performance, ...valid.performance] },
    { ...valid, performance: [performanceRow("2026-08-20", "bad", 100)] },
    { ...valid, positions: [{ ...positionRow(), reportDate: valid.date, pledgedQuantity: 2, availableQuantity: 1 }] },
  ];
  const bucket = { put: async () => assert.fail("不应写入") };
  for (const parsed of invalid) {
    await assert.rejects(archiveBondLedgerRequest(uploadRequest(parsed), bucket, async () => assert.fail("不应导入")),
      error => error instanceof BondLedgerUploadError && error.status === 400);
  }
  await assert.rejects(archiveBondLedgerRequest(uploadRequest(valid, {}, "2026-08-21"), bucket, async () => assert.fail()),
    /报表日必须为/);
});

test("请求体按实际字节限长，不能用伪造长度绕过", async () => {
  const request = new Request("https://eastmoney.hasbai.xyz/api/bond-ledger", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "1" },
    body: new Uint8Array(21 * 1024 * 1024 + 1),
  });
  await assert.rejects(archiveBondLedgerRequest(request, { put: async () => assert.fail() }, async () => assert.fail()),
    error => error instanceof BondLedgerUploadError && error.status === 413);
});

test("上传接口拒绝跨站请求及旧的原始Excel接口", async () => {
  await assert.rejects(archiveBondLedgerRequest(uploadRequest(undefined, { Origin: "https://attacker.example" }), undefined, async () => assert.fail()),
    error => error instanceof BondLedgerUploadError && error.status === 403);
  await assert.rejects(archiveBondLedgerRequest(new Request("https://eastmoney.hasbai.xyz/api/bond-ledger", {
    method: "POST", body: "xlsx-bytes",
  }), {}, async () => assert.fail()), error => error instanceof BondLedgerUploadError && error.status === 415);
});

test("数据库失败不报告成功，也不删除可能已经提交的原始文件", async () => {
  const bucket = { put: async key => ({ key, etag: "test" }), delete: async () => assert.fail("不能删除可能已提交的原件") };
  const failures = [];
  await assert.rejects(archiveBondLedgerRequest(uploadRequest(), bucket, async () => { throw new Error("commit connection lost"); },
    async input => { failures.push(input); }), /commit connection lost/);
  assert.equal(failures.length, 1);
  assert.match(failures[0].r2Key, /^bond-ledger\/imports\//);
  await assert.rejects(archiveBondLedgerRequest(uploadRequest(), { put: async () => null }, async () => assert.fail()), /写入 R2 失败/);
});

test("可导入超过旧3MB限制的有效持仓JSON并保留缺省数量", async () => {
  const parsed = { date: "2026-08-20", performance: [performanceRow("2026-08-20", 1, 100)],
    positions: Array.from({ length: 6000 }, (_, index) => ({ ...positionRow(), reportDate: "2026-08-20", rowNumber: index + 1 })) };
  assert.ok(new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 3 * 1024 * 1024);
  const result = await archiveBondLedgerRequest(uploadRequest(parsed), { put: async key => ({ key, etag: "test" }) }, async input => {
    assert.equal(input.parsed.positions[0].pledgedQuantity, null);
    assert.equal(input.parsed.positions[0].availableQuantity, null);
    return { reportDate: input.parsed.date, positionCount: input.parsed.positions.length };
  });
  assert.equal(result.positionCount, 6000);
});

test("服务端保留解析器允许的有名称无代码行", () => {
  const parsed = { date: "2026-08-20", performance: [performanceRow("2026-08-20", 1, 100)],
    positions: [{ ...positionRow(), reportDate: "2026-08-20", code: "", name: "待补代码债券" }] };
  assert.equal(parsedBondLedgerSchema.parse(parsed).positions[0].name, "待补代码债券");
});

test("下载使用数据库记录的版本路径，历史日期对象仍可下载", async () => {
  for (const key of ["bond-ledger/imports/new.xlsx", bondLedgerObjectKey("2026-08-20")]) {
    const file = { date: "2026-08-20", key };
    const object = { key };
    assert.equal(await getBondLedgerFile({ get: async path => { assert.equal(path, key); return object; } }, file), object);
  }
});

test("数据库导入先获取全局锁再获取同日报表锁", async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes("FROM bond.ledger_upload")) return { rows: [] };
      if (text.includes("max(source_report_date)")) {
        return { rows: [{ latest_source_date: null }] };
      }
      if (text.includes("FROM bond.transaction_record")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const performance = performanceRow("2026-08-20", 1, 100);

  await persistParsedBondLedger(client, {
    uploadId: "00000000-0000-4000-8000-000000000001",
    workflowInstanceId: "00000000-0000-4000-8000-000000000001",
    r2Key: "uploads/test.xlsx",
    r2Etag: "etag-test",
    originalName: "test.xlsx",
    fileSize: 100,
    expectedDate: "2026-08-20",
    uploadedAt: "2026-08-20T10:00:00.000Z",
    parsed: {
      date: "2026-08-20",
      performance: [performance],
      positions: [],
    },
  });

  assert.equal(queries[0], "BEGIN");
  assert.match(queries[1], /bond\.ledger_import/);
  assert.match(queries[2], /hashtextextended\(\$1, 0\)/);
  assert.equal(queries.at(-1), "COMMIT");
});

test("台账日状态从持仓数据库读取而不是按 R2 文件推断", async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes("FROM bond.daily_position")) {
        return {
          rows: [{ date: "2026-08-20" }, { date: "2026-08-21" }],
        };
      }
      return {
        rows: [
          {
            date: "2026-08-21",
            file_name: "二级资金池台账20260821.xlsx",
            r2_key: "uploads/example.xlsx",
            file_size: 170704,
            r2_etag: "etag",
            uploaded_at: "2026-08-24T01:54:23.034Z",
          },
        ],
      };
    },
  };

  const inventory = await listBondLedgerInventory(client);

  assert.deepEqual(inventory.databaseDates, ["2026-08-20", "2026-08-21"]);
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.availableStartDate, "2026-08-20");
  assert.equal(inventory.availableEndDate, "2026-08-21");
  assert.match(queries[0], /FROM bond\.ledger_upload/);
  assert.match(queries[1], /FROM bond\.daily_position/);
});

test("默认范围无台账时回退到上周一至上周五", () => {
  assert.deepEqual(
    resolveAvailableRange(
      ["2026-06-30", "2026-08-25", "2026-08-27"],
      "2026-09-01",
      "2026-09-04",
      "2026-08-24",
      "2026-08-28",
    ),
    {
      startDate: "2026-08-24",
      endDate: "2026-08-28",
      fellBack: true,
    },
  );
  assert.equal(
    resolveAvailableRange(
      ["2026-06-30", "2026-08-14"],
      "2026-09-01",
      "2026-09-04",
      "2026-08-24",
      "2026-08-28",
    ),
    null,
  );
  assert.equal(calendarDays("2026-08-01").length, 42);
  assert.equal(shiftMonth("2026-08-01", 1), "2026-09-01");
});

test("数据库日期首次载入后立即派生日历台账状态", () => {
  const days = calendarDaysWithLedgerStatus("2026-08-01", [
    "2026-08-20",
    "2026-08-21",
  ]);

  assert.equal(days.find((day) => day.date === "2026-08-19")?.hasLedger, false);
  assert.equal(days.find((day) => day.date === "2026-08-20")?.hasLedger, true);
  assert.equal(days.find((day) => day.date === "2026-08-21")?.hasLedger, true);
});

test("旧二级池页面地址永久跳转到 /bond", () => {
  assert.throws(redirectLegacyBondLedger, (error) => {
    assert.equal(error.status, 308);
    assert.equal(error.location, "/bond");
    return true;
  });
});

test("个性化颜色逻辑默认红涨绿跌并写入本地存储", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  assert.equal(readPreferences(storage).marketColorConvention, "red-up-green-down");
  savePreferences({ marketColorConvention: "green-up-red-down" }, storage);
  assert.equal(readPreferences(storage).marketColorConvention, "green-up-red-down");
});

function performanceRow(date, cumulativeProfit, principal) {
  return {
    date,
    principal,
    timeWeightedPrincipal: principal,
    marketValue: principal,
    leverage: 1,
    modifiedDuration: 1,
    dailyRevenue: 0,
    cumulativeProfit,
    ytdAnnualizedReturn: null,
    ytdExTaxAnnualizedReturn: null,
  };
}

function accountSummary(
  date,
  account,
  marketValue,
  taxExemptIncome,
  dv01,
  weightedReportYield,
) {
  return {
    date,
    account,
    marketValue,
    dailyProfit: 0,
    taxExemptIncome,
    dv01,
    weightedReportYield,
    reportYieldWeight: marketValue,
  };
}

function positionMatrixRow(headers, values) {
  return headers.map((header) => values[header] ?? null);
}

function positionRow(overrides = {}) {
  return {
    reportDate: "2026-08-18",
    rowNumber: 1,
    team: "资金管理部",
    investmentManager: "测试经理",
    account: overrides.account ?? "交易户",
    code: overrides.code ?? "TEST.IB",
    market: "银行间",
    name: overrides.name ?? "测试债券",
    category: overrides.category ?? "国债",
    yieldChangeBp: 0,
    remainingYears: 2,
    interestStartDate: "2025-08-18",
    maturityDate: "2028-08-18",
    currentQuantity: 1,
    previousQuantity: 1,
    buyQuantity: overrides.buyQuantity ?? 0,
    sellQuantity: overrides.sellQuantity ?? 0,
    maturityQuantity: overrides.maturityQuantity ?? 0,
    couponRate: 2,
    valuationYield: overrides.reportYield ?? 2,
    reportYield: overrides.reportYield ?? 2,
    fullPrice: 100,
    dv01: 1,
    marketValue: overrides.marketValue ?? 100,
    couponIncome: 0,
    taxExemptIncome: 0,
    realizedProfit: overrides.realizedProfit ?? null,
    dailyProfit: overrides.dailyProfit ?? 1,
    ytdProfit: 2,
    fullPriceCost: 98,
  };
}

function ledger(date, performance, positions) {
  return {
    date,
    performance,
    positions: positions.map((position) => ({ ...position, reportDate: date })),
    fileName: `${date}.xlsx`,
    fileSize: 1,
    fileBlob: new Blob(["x"]),
    uploadedAt: `${date}T10:00:00Z`,
    cloudStored: false,
    cloudKey: null,
  };
}

function uploadRequest(parsed = { date: "2026-08-20", performance: [performanceRow("2026-08-20", 1, 100)], positions: [{ ...positionRow(), reportDate: "2026-08-20" }] }, headers = {}, expectedDate) {
  const body = new FormData();
  body.set("file", new File(["xlsx-bytes"], "台账.xlsx"));
  body.set("parsed", JSON.stringify(parsed));
  if (expectedDate) body.set("expectedDate", expectedDate);
  return new Request("https://eastmoney.hasbai.xyz/api/bond-ledger", { method: "POST", body, headers });
}
