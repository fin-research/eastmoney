import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReportData,
  referencedBondCodes,
} from "../src/market-report-resources.ts";

test("浏览器共享加工层从原始资源构造完整规范报告", () => {
  const todayTrades = [
      {
        bondUniCode: "101",
        remainingTenor: "3Y",
        tradeYield: 2.10,
        cbYte: 2.00,
      },
      {
        bondUniCode: "102",
        remainingTenor: "2Y",
        tradeYield: 2.20,
        cbYte: 2.10,
      },
      {
        bondUniCode: "103",
        remainingTenor: "2Y",
        tradeYield: 2.30,
        cbYte: 2.20,
      },
      {
        bondUniCode: "104",
        remainingTenor: "1Y",
        tradeYield: null,
        cbYte: 1.90,
      },
      {
        bondUniCode: "105",
        remainingTenor: "4.98Y",
        tradeYield: 1.735,
        cbYte: 1.734,
      },
  ];
  const favoriteQuotes = [
      {
        bondUniCode: "101",
        remainingTenor: "3Y",
        remainingTenorDay: 1095,
        cbYield: 2.00,
        bidYield: 2.01,
        ofrYield: 2.02,
      },
  ];
  assert.deepEqual(referencedBondCodes(todayTrades, favoriteQuotes), ["101", "102", "103", "104", "105"]);

  const report = buildReportData({
    reportDate: "2026-08-25",
    generatedAt: "2026-08-25T15:00:00+08:00",
    previousPrimaryDate: "2026-08-22",
    omo: [
        {
          operationDate: "2026-08-25",
          operationName: "逆回购",
          duration: "7D",
          operationAmount: 1000,
          interestRate: 1.40,
        },
    ],
    dr: [
        { bondCode: "DR001", weightedYield: 1.50, weightedYieldUpDownValueBp: 1 },
        { bondCode: "DR007", weightedYield: 1.60, weightedYieldUpDownValueBp: 2 },
      ],
    dibo: [
        { bondCode: "DIBO001", weightedYield: 1.55, weightedYieldUpDownValueBp: 1.5 },
        { bondCode: "DIBO007", weightedYield: 1.65, weightedYieldUpDownValueBp: 2.5 },
      ],
    governmentBonds: [
        {
          ordinateName: "国债",
          abscissaName: "10Y",
          bondCode: "250011",
          yield: 1.80,
          yieldSubYtdCloseBp: -1,
          tradeNum: 10,
        },
    ],
    futures: [
        { contractCode: "T9999", lastPrice: 108.2, upDownValuePct: 0.12 },
      ],
    stock: { paragraphs: ["第一段", "第二段", "不应保留"] },
    margin: [
        {
          DIM_DATE: "2026-08-22",
          TOTAL_RZRQYE: 2e12,
          TOTAL_RZYE: 1.99e12,
          TOTAL_RQYE: 1e10,
        },
        {
          DIM_DATE: "2026-08-21",
          TOTAL_RZRQYE: 1.999e12,
          TOTAL_RZYE: 1.9891e12,
          TOTAL_RQYE: 9.9e9,
        },
    ],
    industry: {
      dataDate: "2026-08-25",
      equities: [{ name: "上证指数", close: 3610.2, change_pct: 0.4 }],
      industries: [{ name: "银行", change_pct: 1.2, market_cap_yuan: 9.8e12 }],
      turnoverYi: 15000,
      turnoverChangeYi: 200,
    },
    primary: [
          {
            bidStartDate: "2026-08-22",
            comShortName: "上期公司",
            bondTypeText: "短期融资券",
            bondShortName: "26上期CP001",
            issueTenor: "1Y",
            planIssueAmount: 40,
            issueCouponRate: 2.1,
          },
          {
            bidStartDate: "2026-08-25",
            comShortName: "本期公司",
            bondTypeText: "短期融资券",
            bondShortName: "26本期CP001",
            issueTenor: "180D",
            planIssueAmount: 30,
            issueCouponRate: 2,
          },
          {
            bidStartDate: "2026-08-25",
            comShortName: "本期公司",
            bondTypeText: "短期融资券",
            bondShortName: "26本期CP002",
            issueTenor: "1Y",
            planIssueAmount: 20,
            issueCouponRate: 2.1,
          },
          {
            bidStartDate: "2026-08-25",
            comShortName: "东方财富",
            bondTypeText: "短期融资券",
            bondShortName: "26东财CP001",
            issueTenor: "1Y",
            planIssueAmount: 999,
          },
    ],
    todayTrades,
    favoriteQuotes,
    bondInfos: [
        { bondUniCode: "101", bondShortName: "26测试01", comShortName: "测试公司", bondType: 37, bondOfferingType: 1, sciTechInnoBondStatus: 0 },
        { bondUniCode: "102", bondShortName: "26东财01", comShortName: "东方财富", bondType: 37, bondOfferingType: 1, sciTechInnoBondStatus: 0 },
        { bondUniCode: "103", bondShortName: "26私募01", comShortName: "私募公司", bondType: 37, bondOfferingType: 2, sciTechInnoBondStatus: 0 },
        { bondUniCode: "104", bondShortName: "26缺失01", comShortName: "缺失公司", bondType: 37, bondOfferingType: 1, sciTechInnoBondStatus: 0 },
        { bondUniCode: "105", bondShortName: "26中证K2", comShortName: "中信证券", bondType: 37, bondOfferingType: 1, sciTechInnoBondStatus: 1 },
      ],
  });

  assert.equal(report.omo_operations[0].amount_yi, 1000);
  assert.deepEqual(report.funding_rates.map((item) => item.code), [
    "DR001",
    "DR007",
    "DIBO001",
    "DIBO007",
  ]);
  assert.equal(report.government_bonds[0].code, "250011");
  assert.equal(report.futures[0].code, "T9999");
  assert.deepEqual(report.stock_paragraphs, ["第一段", "第二段"]);
  assert.equal(report.margin.total_change, 10);
  assert.deepEqual(report.primary_summary, { current_amount: 50, change_amount: 10 });
  assert.equal(report.primary_issues[0].amount, 50);
  assert.deepEqual(report.primary_issues[0].tenors, ["180天", "1年"]);
  assert.equal(report.secondary_bonds.length, 1);
  assert.equal(report.secondary_bonds[0].issuer, "测试公司");
  assert.ok(!report.secondary_bonds.some((item) => item.bond_name === "26中证K2"));
  assert.equal(report.inventory_bonds[0].bid_yield, 2.01);
});

test("东财债券零 Bid/Ofr 归一为空但债券仍保留", () => {
  const report = buildReportData({
    reportDate: "2026-08-25",
    generatedAt: "2026-08-25T15:00:00+08:00",
    previousPrimaryDate: "2026-08-22",
    omo: [], dr: [], dibo: [], governmentBonds: [], futures: [],
    stock: { title: "收评", time: null, paragraphs: [] },
    margin: [],
    industry: {
      dataDate: "2026-08-25", equities: [], industries: [],
      turnoverYi: null, turnoverChangeYi: null, tradingDates: ["2026-08-22"],
    },
    primary: [], todayTrades: [],
    favoriteQuotes: [{
      bondUniCode: "101", remainingTenor: "1Y", remainingTenorDay: 365,
      cbYield: 1.8, bidYield: 0, bidEntryPrice: 0, ofrYield: 0, ofrEntryPrice: 0,
    }],
    bondInfos: [{
      bondUniCode: "101", bondShortName: "25东财G1",
      comShortName: "东方财富证券", bondType: 37, bondOfferingType: 1,
      sciTechInnoBondStatus: 0,
    }],
  });
  assert.equal(report.inventory_bonds.length, 1);
  assert.equal(report.inventory_bonds[0].bond_name, "25东财G1");
  assert.equal(report.inventory_bonds[0].bid_yield, null);
  assert.equal(report.inventory_bonds[0].ofr_yield, null);
});

test("东财存量债剔除净价误填的成交收益率及利差，并仅回退有效成交", () => {
  const makeReport = (tradeEntryPrice, tradeYield = null) => buildReportData({
    reportDate: "2026-09-15", generatedAt: "2026-09-15T15:00:00+08:00",
    previousPrimaryDate: "2026-09-14",
    omo: [], dr: [], dibo: [], governmentBonds: [], futures: [],
    stock: { title: "收评", time: null, paragraphs: [] }, margin: [],
    industry: { dataDate: "2026-09-15", equities: [], industries: [],
      turnoverYi: null, turnoverChangeYi: null, tradingDates: [] },
    primary: [],
    todayTrades: [{ bondUniCode: "1000974894", remainingTenor: "3Y", tradeYield, cbYte: 1.7124 }],
    favoriteQuotes: [{ bondUniCode: "1000974894", remainingTenor: "3Y",
      remainingTenorDay: 1095, cbYield: 1.7124, tradeEntryPrice,
      tradeYieldSubCb: -1.43, bidYield: 1.72, ofrYield: 1.7 }],
    bondInfos: [{ bondUniCode: "1000974894", bondShortName: "26东财01",
      comShortName: "东方财富证券", bondType: 37, bondOfferingType: 1,
      sciTechInnoBondStatus: 0 }],
  }).inventory_bonds[0];

  for (const invalid of [100, 99.8, 101, 0, -1]) {
    const bond = makeReport(invalid, invalid);
    assert.equal(bond.trade_yield, null);
    assert.equal(bond.trade_spread_bp, null);
    assert.equal(bond.valuation, 1.7124);
    assert.equal(bond.bid_yield, 1.72);
    assert.equal(bond.ofr_yield, 1.7);
  }
  const fallback = makeReport(100, 1.7);
  assert.equal(fallback.trade_yield, 1.7);
  assert.equal(fallback.trade_spread_bp, -1.24);
  const normal = makeReport(1.6981, 100);
  assert.equal(normal.trade_yield, 1.6981);
  assert.equal(normal.trade_spread_bp, -1.43);
});
