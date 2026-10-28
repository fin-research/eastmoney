import { describe, expect, it } from "vitest";

import {
  brokerBondRegistrationSchema,
  bondInfoSchema,
  cfetsHistoryPageSchema,
  cfetsRateSchema,
  futuresQuoteSchema,
  governmentBondSchema,
  marginBalanceSchema,
  newsDetailSchema,
  omoOperationSchema,
  parseObject,
  parseRows,
  todayTradeSchema,
} from "../src/contracts";

describe("public REST DTO normalization", () => {
  it.each([null, undefined, "--", ""])("preserves missing government bond yield %s as null", (value) => {
    expect(parseRows(governmentBondSchema, [{
      ordinateName: "国债", abscissaName: "10Y", bondCode: "260011.IB",
      tradeNum: "20", yield: value, yieldSubYtdCloseBp: null,
    }], "国债行情")[0]).toEqual({
      ordinateName: "国债", abscissaName: "10Y", bondCode: "260011.IB",
      tradeNum: 20, yield: null, yieldSubYtdCloseBp: null,
    });
  });

  it.each(["not-a-yield", {}, true, Infinity])("rejects malformed government bond yield %s", (value) => {
    expect(() => parseRows(governmentBondSchema, [{
      ordinateName: "国债", abscissaName: "10Y", bondCode: "260011.IB",
      tradeNum: 20, yield: value, yieldSubYtdCloseBp: null,
    }], "国债行情")).toThrow("国债行情上游数据格式异常");
  });

  it("normalizes numeric strings and upstream missing-value markers", () => {
    expect(parseRows(omoOperationSchema, [{
      operationDate: "2026-08-31",
      operationName: "逆回购",
      duration: "隔夜",
      interestRate: "--",
      operationAmount: "4470",
    }], "OMO")).toEqual([{
      operationDate: "2026-08-31",
      operationName: "逆回购",
      duration: "隔夜",
      interestRate: null,
      operationAmount: 4470,
    }]);

    expect(parseRows(omoOperationSchema, [{
      operationDate: "2026-08-31",
      operationName: "逆回购到期",
      duration: "7D",
      interestRate: undefined,
      operationAmount: undefined,
    }], "OMO")[0]).toMatchObject({
      interestRate: null,
      operationAmount: null,
    });

    expect(parseRows(futuresQuoteSchema, [{
      contractCode: "TS2609",
    }], "国债期货")).toEqual([{
      contractCode: "TS2609",
      lastPrice: null,
      upDownValuePct: null,
    }]);

    expect(parseRows(cfetsRateSchema, [{
      bondCode: "DR007.IB",
    }], "CFETS")).toEqual([{
      bondCode: "DR007.IB",
      weightedYield: null,
      weightedYieldUpDownValueBp: null,
    }]);

    expect(parseRows(governmentBondSchema, [{
      ordinateName: "国债",
      abscissaName: "10Y",
      bondCode: "250011.IB",
      tradeNum: "20",
      yield: "1.80",
      yieldSubYtdCloseBp: "--",
    }], "国债行情")[0]?.yieldSubYtdCloseBp).toBeNull();

    expect(parseRows(todayTradeSchema, [{
      bondUniCode: 101,
      remainingTenor: "3Y",
    }], "今日成交")).toEqual([{
      bondUniCode: "101",
      remainingTenor: "3Y",
      cbYte: null,
      tradeYield: null,
      tradeYieldSubCb: null,
    }]);
  });

  it("normalizes dates, identifiers and absent article bodies", () => {
    expect(parseRows(marginBalanceSchema, [{
      DIM_DATE: "2026-08-28 00:00:00",
      TOTAL_RZRQYE: 1,
      TOTAL_RZYE: 2,
      TOTAL_RQYE: 3,
    }], "两融")[0]?.DIM_DATE).toBe("2026-08-28");

    expect(parseRows(bondInfoSchema, [{
      bondUniCode: 101,
      bondShortName: "25东财G1",
      comShortName: "东方财富",
      bondType: "1",
      bondOfferingType: "1",
      sciTechInnoBondStatus: "0",
      unusedUpstreamField: "discarded",
    }], "债券信息")).toEqual([{
      bondUniCode: "101",
      bondShortName: "25东财G1",
      comShortName: "东方财富",
      bondType: 1,
      bondOfferingType: 1,
      sciTechInnoBondStatus: 0,
    }]);

    expect(parseObject(newsDetailSchema, {
      sentimentId: "news-1",
      title: "标题",
      time: "2026-08-31T15:00:00+08:00",
      tags: [],
    }, "新闻详情").content).toBe("");

    expect(parseRows(brokerBondRegistrationSchema, [{
      projectName: "测试项目",
      issuerName: "测试证券股份有限公司",
      status: "已受理",
      variety: "小公募",
      amountYi: "100",
      updateDate: "2026-08-28 12:00:00",
    }], "券商债券申报")).toEqual([{
      projectName: "测试项目",
      issuerName: "测试证券股份有限公司",
      status: "已受理",
      variety: "小公募",
      amountYi: 100,
      region: null,
      industry: null,
      leadUnderwriter: null,
      noticeNumber: null,
      venue: null,
      registrationOrFiling: null,
      updateDate: "2026-08-28",
    }]);
  });

  it("normalizes lossless CFETS history cursors and sparse rates", () => {
    const page = parseObject(cfetsHistoryPageSchema, {
      hasNextPage: true,
      rows: [{
        bondCode: "DR007",
        weightedYield: "1.5234",
        capitalTime: "1763308799000",
      }],
    }, "CFETS 历史资金利率");

    expect(page).toEqual({
      hasNextPage: true,
      rows: [{
        bondCode: "DR007",
        capitalTime: 1_763_308_799_000,
        weightedYield: 1.5234,
        weightedAvgRate: null,
        lastPrice: null,
        weightedYieldUpDownValueBp: null,
      }],
    });
  });
});
