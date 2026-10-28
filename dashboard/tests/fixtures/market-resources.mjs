import assert from "node:assert/strict";
export function snapshot() {
  return {
    report_date: "2026-08-25",
    generated_at: "2026-08-25T15:00:00+08:00",
    omo_operations: [],
    funding_rates: [],
    government_bonds: [],
    futures: [],
    stock_paragraphs: ["A股主要指数收涨。"],
    margin: {
      data_date: "2026-08-22",
      total: 20000,
      total_change: 10,
      financing: 19900,
      financing_change: 9,
      securities_lending: 100,
      securities_lending_change: 1,
    },
    equities: [{ name: "上证指数", close: 3610.2, change_pct: 0.4 }],
    equity_data_time: null,
    turnover_yi: 15000,
    turnover_change_yi: 200,
    industries: [{ name: "银行", change_pct: 1.2, market_cap_yuan: 9.8e12 }],
    industry_data_date: "2026-08-25",
    primary_summary: { current_amount: 0, change_amount: 0 },
    primary_issues: [],
    secondary_bonds: [],
    inventory_bonds: [],
    focus_text: "",
    cached_at: "2026-08-25T15:01:00+08:00",
    finalized_at: null,
  };
}

function marginRows() {
  return [
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
  ];
}

export function directResponse(target) {
  const url = new URL(String(target), "https://example.test");
  if (url.pathname === "/data/trading-days") {
    return Response.json({ date: url.searchParams.get("date") ?? "2026-08-25", isTradingDay: true,
      previousTradingDate: url.searchParams.get("date") === "2026-08-31" ? "2026-08-28" : "2026-08-24" });
  }
  if (url.pathname === "/data/industry") {
    return Response.json({
      dataDate: "2026-08-25",
      equities: snapshot().equities,
      industries: snapshot().industries,
      turnoverYi: 15000,
      turnoverChangeYi: 200,
      tradingDates: ["2026-08-24", "2026-08-25"],
    });
  }
  if (url.pathname === "/data/stock-summary") {
    return Response.json({
      title: "A股收评",
      time: "2026-08-25T15:00:00+08:00",
      paragraphs: snapshot().stock_paragraphs,
    });
  }
  if (url.pathname === "/data/omo") {
    return Response.json({
      data: [{
        operationDate: "2026-08-25",
        operationName: "逆回购",
        duration: "7D",
        interestRate: "--",
        operationAmount: "1000",
      }],
    });
  }
  if (url.pathname === "/data/cfets") {
    return Response.json(
      url.searchParams.get("source") === "DR"
        ? [{ bondCode: "DR007" }]
        : [],
    );
  }
  if (url.pathname === "/data/bond-top-case") {
    return Response.json([]);
  }
  if (url.pathname === "/data/futures-latest") {
    return Response.json([{ contractCode: "TL9999" }]);
  }
  if (url.pathname === "/data/margin") {
    return Response.json(marginRows());
  }
  if (url.pathname === "/data/primary-issues") {
    assert.equal(
      url.searchParams.get("startDate"),
      url.searchParams.get("date") === "2026-08-31"
        ? "2026-08-28"
        : "2026-08-24",
    );
    return Response.json([]);
  }
  if (url.pathname === "/data/today-trades") {
    return Response.json([
        {
          bondUniCode: "123",
          remainingTenor: "3Y",
          tradeYield: 2.10,
          cbYte: 2.00,
        },
    ]);
  }
  if (url.pathname === "/data/favorite-quotes") {
    return Response.json([
        {
          bondUniCode: "123",
          remainingTenor: "3Y",
          remainingTenorDay: 1095,
          cbYield: 2.00,
          bidYield: 2.01,
          ofrYield: 2.02,
        },
    ]);
  }
  if (url.pathname === "/data/bond-infos") {
    assert.equal(url.searchParams.get("codes"), "123");
    assert.equal(
      url.searchParams.get("fields"),
      "bondUniCode,bondShortName,comShortName,bondType,bondOfferingType,sciTechInnoBondStatus",
    );
    return Response.json([{
      bondUniCode: "123",
      bondShortName: "26测试01",
      comShortName: "测试公司",
      bondType: 37,
      bondOfferingType: 1,
      sciTechInnoBondStatus: 0,
    }]);
  }
  throw new Error(`unexpected request: ${target}`);
}
