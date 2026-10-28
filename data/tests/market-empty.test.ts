import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/app";
import { bondInfoSchema, governmentBondSchema, marginBalanceSchema, primaryIssueSchema, favoriteQuoteSchema, todayTradeSchema, omoOperationSchema, parseRows } from "../src/contracts";
import { fetchMarginHistory } from "../src/eastmoney";
import { allowRateLimits } from "./rate-limit-bindings";

const bindings = (fetch: (request: Request) => Promise<Response>) => ({
  DM: { fetch }, DM_COOKIE: "device_id=test", CHOICE_RPC: { fetch }, CHOICE_RPC_TOKEN: "test",
  ...allowRateLimits(),
}) as unknown as Cloudflare.Env;

describe("empty market data boundaries", () => {
  it("keeps sparse scalar fields and does not coerce missing values to zero", () => {
    for (const missing of [null, undefined, "", " -- ", "   "]) {
      expect(parseRows(governmentBondSchema, [{ bondCode: "260010.IB", tradeNum: missing, yield: 0 }], "bonds")[0]).toMatchObject({ tradeNum: null, yield: 0 });
      expect(parseRows(marginBalanceSchema, [{ DIM_DATE: "2026-09-10", TOTAL_RZRQYE: missing, TOTAL_RZYE: 10, TOTAL_RQYE: 0 }], "margin")[0]).toMatchObject({ TOTAL_RZRQYE: null, TOTAL_RZYE: 10, TOTAL_RQYE: 0 });
      expect(parseRows(primaryIssueSchema, [{ bondShortName: "测试债", planIssueAmount: missing, comShortName: null }], "primary")[0]?.planIssueAmount).toBeNull();
      expect(parseRows(bondInfoSchema, [{ bondUniCode: 123, bondType: missing, bondOfferingType: missing, sciTechInnoBondStatus: missing }], "info")[0]).toMatchObject({ bondUniCode: "123", bondType: null, sciTechInnoBondStatus: null });
      expect(parseRows(favoriteQuoteSchema, [{ bondUniCode: 123, remainingTenorDay: missing, remainingTenor: null, bondShortName: null }], "quotes")[0]?.remainingTenorDay).toBeNull();
    }
    expect(parseRows(todayTradeSchema, [{ bondUniCode: 123, remainingTenor: null }], "trades")).toHaveLength(1);
    expect(parseRows(omoOperationSchema, [{ operationDate: "2026-09-10", operationName: null, duration: null }], "OMO")).toHaveLength(1);
  });

  it("isolates empty rows and missing identifiers while rejecting non-empty corruption", () => {
    const valid = { bondCode: "260010.IB", yield: 1.8 };
    expect(parseRows(governmentBondSchema, [null, {}, { bondCode: null, yield: 1.9 }, valid], "bonds")).toHaveLength(1);
    for (const payload of [null, undefined, [], [null, {}]]) expect(parseRows(governmentBondSchema, payload, "bonds")).toEqual([]);
    expect(() => parseRows(governmentBondSchema, [valid, { ...valid, yield: "broken" }], "bonds")).toThrow();
    expect(() => parseRows(governmentBondSchema, { data: [] }, "bonds")).toThrow();
  });

  it("accepts null REST collections and nested primary pages, including through GraphQL", async () => {
    const env = bindings(async () => Response.json({ code: 0, data: null }));
    for (const path of ["/bond-top-case", "/primary-issues", "/bond-infos?codes=123", "/omo?startDate=2026-09-10&endDate=2026-09-10"]) {
      const response = await handleRequest(new Request(`https://example.test${path}`), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
    const response = await handleRequest(new Request("https://example.test/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: '{ bondTopCase(date: "2026-09-10") primaryIssues(date: "2026-09-10") }' }),
    }), env);
    expect(await response.json()).toEqual({ data: { bondTopCase: [], primaryIssues: [] } });
    const error = await handleRequest(new Request("https://example.test/bond-top-case"), bindings(async () => Response.json({ code: 401, data: null })));
    expect(error.status).toBe(503);
    expect(await error.json()).toMatchObject({ error: { code: "UPSTREAM_API_ERROR" } });
  });

  it("keeps the latest margin row when only one balance is missing", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: { data: [
      { DIM_DATE: "2026-09-10", TOTAL_RZRQYE: null, TOTAL_RZYE: 10, TOTAL_RQYE: 0 },
      { DIM_DATE: "2026-09-09", TOTAL_RZRQYE: 9, TOTAL_RZYE: 8, TOTAL_RQYE: 1 },
    ] } }));
    try {
      const rows = await fetchMarginHistory("2026-09-10", allowRateLimits());
      expect(rows[0]?.DIM_DATE).toBe("2026-09-10");
      expect(rows).toHaveLength(2);
      mock.mockResolvedValue(Response.json({ result: null }));
      expect(await fetchMarginHistory("2026-09-10", allowRateLimits())).toEqual([]);
    } finally { mock.mockRestore(); }
  });

});
