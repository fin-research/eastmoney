import { deflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { handleRequest } from "../src/app";
import { signedDmUrl } from "../src/dm/client";
import { articleParagraphsFromHtml } from "../src/eastmoney";
import { internalPathname } from "../src/routing";
import { allowRateLimits } from "./rate-limit-bindings";

function tableResponse(value: unknown): Response {
  return Response.json(value, {
    headers: { "X-Choice-Rpc-Version": "choice.rpc.v1" },
  });
}

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  const unavailable = { fetch: vi.fn(async () => new Response("unavailable", { status: 503 })) };
  return {
    DM: unavailable,
    CHOICE_RPC: unavailable,
    DM_COOKIE: "device_id=test-device; session=test",
    CHOICE_RPC_TOKEN: "rpc-test-token",
    ...allowRateLimits(),
    ...overrides,
  } as Cloudflare.Env;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function fieldVarint(number: number, value: bigint): Uint8Array {
  return concat(varint(BigInt(number << 3)), varint(value));
}

function fieldBytes(number: number, value: Uint8Array): Uint8Array {
  return concat(varint(BigInt((number << 3) | 2)), varint(BigInt(value.length)), value);
}

function fieldString(number: number, value: string): Uint8Array {
  return fieldBytes(number, new TextEncoder().encode(value));
}

function fieldDouble(number: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat(varint(BigInt((number << 3) | 1)), bytes);
}

function cfetsHistoryResponse(): Response {
  const row = concat(
    fieldVarint(1, 1_788_000_000_100n),
    fieldVarint(2, 9_007_199_254_740_993n),
    fieldString(3, "DR001"),
    fieldDouble(4, 1.5234),
    fieldDouble(12, 1.51),
    fieldDouble(20, 1.52),
    fieldString(10, "DR001"),
    fieldVarint(11, 1_763_308_799_000n),
    fieldDouble(23, -0.25),
  );
  const page = concat(fieldVarint(1, 1n), fieldBytes(2, row));
  const envelope = concat(
    fieldVarint(1, 0n),
    fieldString(2, "success"),
    fieldBytes(3, page),
  );
  return new Response(new Uint8Array(deflateSync(envelope)));
}

function todayTradeResponse(): Response {
  const completeTrade = concat(
    fieldVarint(5, 101n),
    fieldString(7, "3Y"),
    fieldDouble(27, 2.0),
    fieldDouble(35, 2.1),
    fieldDouble(40, 10),
  );
  const sparseTrade = concat(
    fieldVarint(5, 102n),
    fieldString(7, "2Y"),
    fieldDouble(27, 1.9),
  );
  const list = concat(
    fieldBytes(1, fieldBytes(1, completeTrade)),
    fieldBytes(1, fieldBytes(1, sparseTrade)),
  );
  const envelope = concat(
    fieldVarint(1, 0n),
    fieldString(2, "success"),
    fieldBytes(3, list),
  );
  return new Response(new Uint8Array(deflateSync(envelope)));
}

describe("public route rewrite", () => {
  it("strips only the exact /data prefix", () => {
    expect(internalPathname("/data/news")).toBe("/news");
    expect(internalPathname("/health")).toBe("/health");
    expect(internalPathname("/data")).toBe("/");
    expect(internalPathname("/database")).toBeNull();
    expect(internalPathname("/data-export")).toBeNull();
  });
});

describe("Worker boundary", () => {
  it("serves health and keeps the public response no-store", async () => {
    const response = await handleRequest(
      new Request("https://eastmoney.hasbai.xyz/data/health"),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns the historical 404 shape for route collisions", async () => {
    const response = await handleRequest(
      new Request("https://eastmoney.hasbai.xyz/database"),
      env(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Not Found" });
  });

  it("exposes docs and the migrated OpenAPI paths", async () => {
    const docs = await handleRequest(
      new Request("https://eastmoney.hasbai.xyz/data/docs"),
      env(),
    );
    expect(await docs.text()).toContain("url: '/data/openapi.json'");
    const schema = await handleRequest(
      new Request("https://eastmoney.hasbai.xyz/data/openapi.json"),
      env(),
    );
    const body = (await schema.json()) as { info: { title: string }; paths: Record<string, unknown> };
    expect(body.info.title).toBe("东方财富市场数据 API");
    expect(Object.keys(body.paths).sort()).toEqual([
      "/bond-infos", "/bond-top-case", "/broker-bond-registrations", "/cfets", "/cfets-histories",
      "/chinamoney/shibor", "/choice/csd", "/choice/css",
      "/choice/ctr", "/choice/data-statistics", "/choice/edb", "/config",
      "/favorite-quotes", "/futures-latest", "/graphql", "/health", "/industry",
      "/margin", "/news", "/news/{article_id}", "/omo",
      "/primary-issues", "/stock-summary", "/today-trades", "/trading-days",
      "/wechat-articles",
    ]);
  });

  it("adds CORS only for the established local dashboard origins", async () => {
    const local = await handleRequest(
      new Request("https://example.test/health", {
        headers: { Origin: "http://localhost:8765" },
      }),
      env(),
    );
    expect(local.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8765");
    const foreign = await handleRequest(
      new Request("https://example.test/health", {
        headers: { Origin: "https://attacker.example" },
      }),
      env(),
    );
    expect(foreign.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
});

describe("Choice office RPC", () => {
  it("maps the public GET contract to the allowlisted CSD RPC", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/rpc/v1/choice/csd");
      expect(request.method).toBe("POST");
      expect(request.headers.get("Authorization")).toBe("Bearer rpc-test-token");
      expect(await request.json()).toEqual({
        codes: "000001.SH",
        indicators: "CLOSE",
        startDate: "2026-08-25",
        endDate: "2026-08-25",
        options: "Period=1",
      });
      return tableResponse({
        function: "CSD",
        fields: ["code", "date", "CLOSE"],
        rows: [{ code: "000001.SH", date: "2026-08-25", CLOSE: 3610.2 }],
      });
    });
    const response = await handleRequest(
      new Request(
        "https://eastmoney.hasbai.xyz/data/choice/csd?codes=000001.SH&indicators=CLOSE&startDate=2026-08-25&endDate=2026-08-25&options=Period%3D1",
      ),
      env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toHaveProperty("function", "CSD");
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("rejects inverted dates before calling the office", async () => {
    const bindingFetch = vi.fn();
    const response = await handleRequest(
      new Request(
        "https://example.test/choice/csd?codes=000001.SH&indicators=CLOSE&startDate=2026-08-26&endDate=2026-08-25",
      ),
      env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "startDate 不能晚于 endDate" });
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("rejects an office response without the versioned RPC contract", async () => {
    const bindingFetch = vi.fn(async () => Response.json({
      function: "CSS",
      fields: ["code"],
      rows: [{ code: "000001.SH" }],
    }));
    const response = await handleRequest(
      new Request(
        "https://example.test/choice/css?codes=000001.SH&indicators=NAME",
      ),
      env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Choice RPC version mismatch",
      error: {
        code: "UPSTREAM_VERSION_MISMATCH",
        source: "Choice RPC",
        stage: "response_headers",
        upstreamStatus: 200,
        upstreamPath: "/rpc/v1/choice/css",
      },
    });
  });

  it("validates one shared Choice DTO before both REST and GraphQL boundaries", async () => {
    const bindingFetch = vi.fn(async () => tableResponse({
      function: "CSS",
      fields: ["code"],
      rows: "not-an-array",
    }));
    const testEnv = env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher });

    const restResponse = await handleRequest(
      new Request("https://example.test/choice/css?codes=000001.SH&indicators=NAME"),
      testEnv,
    );
    expect(restResponse.status).toBe(503);
    expect(await restResponse.json()).toMatchObject({
      detail: "Choice RPC returned an invalid table",
      error: {
        code: "UPSTREAM_SCHEMA_MISMATCH",
        source: "Choice RPC",
        stage: "response_validation",
      },
    });

    const graphqlResponse = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ config choiceCss(codes: \"000001.SH\", indicators: \"NAME\") { function fields rows } }",
        }),
      }),
      testEnv,
    );
    const body = await graphqlResponse.json() as {
      data: { config: { defaultDate: string }; choiceCss: null };
      errors: Array<{ message: string; path: string[] }>;
    };
    expect(body.data.config.defaultDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.choiceCss).toBeNull();
    expect(body.errors[0]).toMatchObject({
      message: "Choice RPC returned an invalid table",
      path: ["choiceCss"],
    });
    expect(bindingFetch).toHaveBeenCalledTimes(2);
  });

  it("fails the report market snapshot when CSS is unavailable instead of returning an empty heatmap", async () => {
    const publicFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected public fallback"));
    const choiceFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/tradedates")) return tableResponse({
        function: "TRADEDATES", fields: ["date"], rows: [{ date: "2026-09-10" }, { date: "2026-09-11" }],
      });
      return new Response("unavailable", { status: 503 });
    });
    let response: Response;
    try {
      response = await handleRequest(
        new Request("https://example.test/industry?date=2026-09-11"),
        env({ CHOICE_RPC: { fetch: choiceFetch } as unknown as Fetcher }),
      );
    } finally { publicFetch.mockRestore(); }
    expect(response.status).toBe(503);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(choiceFetch).toHaveBeenCalledTimes(2);
    expect(new URL(choiceFetch.mock.calls[0]![0].url).pathname).toBe("/rpc/v1/choice/tradedates");
    expect(new URL(choiceFetch.mock.calls[1]![0].url).pathname).toBe("/rpc/v1/choice/css");
  });

  it("serves an independent exchange trading calendar", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      const body = await request.json() as { endDate: string };
      return tableResponse({ function: "TRADEDATES", fields: ["date"], rows: body.endDate === "2026-09-23"
        ? [{ date: "2026-09-22" }, { date: "2026-09-23" }]
        : [{ date: "2026-09-23" }, { date: "2026-09-24" }, { date: "2026-09-28" }] });
    });
    const bindings = env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher });
    const response = await handleRequest(new Request("https://example.test/trading-days?date=2026-09-23"), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ date: "2026-09-23", isTradingDay: true, previousTradingDate: "2026-09-22" });
    const closure = await handleRequest(new Request("https://example.test/trading-days?date=2026-09-28"), bindings);
    expect(await closure.json()).toMatchObject({ isTradingDay: true, previousTradingDate: "2026-09-24" });
    expect(bindingFetch.mock.calls.every(([request]) => new URL(request.url).pathname === "/rpc/v1/choice/tradedates")).toBe(true);
  });

  it("fills all 31 industries from CSS and gets turnover comparison from the calendar", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      const payload = await request.json() as { codes?: string; options?: string };
      if (path.endsWith("/tradedates")) return tableResponse({ function: "TRADEDATES", fields: ["date"],
        rows: [{ date: "2026-09-22" }, { date: "2026-09-23" }] });
      const isTurnover = payload.codes === "800004.EI";
      return tableResponse({ function: "CSS", fields: isTurnover ? ["code", "AMOUNT"] : ["code", "CLOSE", "PRECLOSE", "MV"],
        rows: isTurnover ? [{ code: "800004.EI", AMOUNT: payload.options?.includes("2026-09-23") ? 2.1e12 : 2e12 }]
          : payload.codes!.split(",").map(code => ({ code, CLOSE: 101, PRECLOSE: 100, MV: 1e12 })) });
    });
    const response = await handleRequest(new Request("https://example.test/industry?date=2026-09-23"),
      env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher }));
    const body = await response.json() as { industries: unknown[]; equities: unknown[]; turnoverYi: number; turnoverChangeYi: number };
    expect(response.status).toBe(200);
    expect(body.industries).toHaveLength(31);
    expect(body.equities).toHaveLength(4);
    expect(body.turnoverYi).toBe(21_000);
    expect(body.turnoverChangeYi).toBe(1_000);
    expect(bindingFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      "/rpc/v1/choice/tradedates", "/rpc/v1/choice/css", "/rpc/v1/choice/css", "/rpc/v1/choice/css",
    ]);
  });

  it("keeps GraphQL Choice fields on the same RPC contract", async () => {
    const bindingFetch = vi.fn(async () => tableResponse({
      function: "CSS",
      fields: ["code", "NAME"],
      rows: [{ code: "000001.SH", NAME: "上证指数" }],
    }));
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ choiceCss(codes: \"000001.SH\", indicators: \"NAME\") { function fields rows } }",
        }),
      }),
      env({ CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    const body = (await response.json()) as { data?: { choiceCss?: { function: string } } };
    expect(response.status).toBe(200);
    expect(body.data?.choiceCss?.function).toBe("CSS");
  });

  it("removes market-report processing from the compatibility GraphQL schema", async () => {
    const bindingFetch = vi.fn();
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ reportDate(request: { date: \"2026-08-25\" }) }",
        }),
      }),
      env({
        DM: { fetch: bindingFetch } as unknown as Fetcher,
        CHOICE_RPC: { fetch: bindingFetch } as unknown as Fetcher,
      }),
    );
    const body = (await response.json()) as { errors?: Array<{ message: string }> };
    expect(response.status).toBe(200);
    expect(body.errors?.[0]?.message).toContain('Cannot query field "reportDate"');
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("serves the pinned interactive GraphiQL assets", async () => {
    const response = await handleRequest(
      new Request("https://example.test/graphql"),
      env(),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("graphiql@3.8.3/graphiql.min.js");
    expect(html).toContain("GraphiQL.createFetcher");
  });

  it("exposes every public data resource as a thin GraphQL field", async () => {
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ __schema { queryType { fields { name } } } }",
        }),
      }),
      env(),
    );
    const body = await response.json() as {
      data: { __schema: { queryType: { fields: Array<{ name: string }> } } };
    };
    expect(body.data.__schema.queryType.fields.map((field) => field.name).sort())
      .toEqual([
        "bondInfos", "bondTopCase", "brokerBondRegistrations", "cfets",
        "cfetsHistories", "chinamoneyShibor", "choiceCsd", "choiceCss", "choiceCtr",
        "choiceDataStatistics", "choiceEdb", "config", "favoriteQuotes",
        "futuresLatest", "health", "industry", "margin", "news",
        "newsDetail", "omo", "primaryIssues", "stockSummary", "todayTrades", "tradingDays",
        "wechatArticles",
      ]);
  });

  it("reuses the REST bond-info contract from the GraphQL thin layer", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/onshore-bond-basic/api/bond/filter/simple/v3/onshore/batch",
      );
      expect(await request.json()).toEqual({ bondUniCodes: [101] });
      return Response.json({
        code: 0,
        data: [{
          bondUniCode: 101,
          bondShortName: "26测试01",
          comShortName: "测试证券",
          bondType: 37,
          bondOfferingType: 1,
          sciTechInnoBondStatus: 0,
        }],
      });
    });
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ bondInfos(codes: \"101\", fields: \"bondUniCode,bondShortName,bondType\") }",
        }),
      }),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(await response.json()).toEqual({
      data: {
        bondInfos: [{
          bondUniCode: "101",
          bondShortName: "26测试01",
          bondType: 37,
        }],
      },
    });
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("keeps successful sibling fields when one GraphQL resource fails", async () => {
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ config bondInfos(codes: \"101\") }",
        }),
      }),
      env({
        DM: {
          fetch: vi.fn(async () => new Response("not-json", { status: 200 })),
        } as unknown as Fetcher,
      }),
    );
    const body = await response.json() as {
      data: { config: { defaultDate: string }; bondInfos: null };
      errors: Array<{ path: string[] }>;
    };
    expect(body.data.config.defaultDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.bondInfos).toBeNull();
    expect(body.errors[0]?.path).toEqual(["bondInfos"]);
  });

  it("bounds repeated GraphQL resource aliases below the Worker subrequest limit", async () => {
    const bindingFetch = vi.fn(async () => Response.json({ code: 0, data: [] }));
    const aliases = Array.from(
      { length: 41 },
      (_value, index) => `bond${index}: bondInfos(codes: "${index + 1}")`,
    ).join("\n");
    const response = await handleRequest(
      new Request("https://example.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ ${aliases} }` }),
      }),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    const body = await response.json() as {
      data: Record<string, unknown>;
      errors: Array<{ path: string[]; extensions: { code: string } }>;
    };
    expect(response.status).toBe(200);
    expect(bindingFetch).toHaveBeenCalledTimes(40);
    expect(body.data.bond0).toEqual([]);
    expect(body.data.bond40).toBeNull();
    expect(body.errors[0]).toMatchObject({
      path: ["bond40"],
      extensions: { code: "QUERY_RESOURCE_LIMIT" },
    });
  });
});

describe("DM private binding", () => {
  it("preserves mixed available and missing bond yields in REST projections and GraphQL", async () => {
    const rows = [
      { ordinateName: "国债", abscissaName: "10Y", bondCode: "260011.IB", tradeNum: 20, yield: 1.8, yieldSubYtdCloseBp: -1 },
      { ordinateName: "国债", abscissaName: "5Y", bondCode: "260010.IB", tradeNum: 1, yield: null, yieldSubYtdCloseBp: null },
    ];
    const bindingFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/onshore-bond-price-apollo/api/rate/matrix/top-case");
      expect(url.searchParams.get("issueDate")).toBe("2026-09-09");
      return Response.json({ code: 0, data: rows.map((row) => ({ ...row, privateField: "discarded" })) });
    });
    const bindings = env({ DM: { fetch: bindingFetch } as unknown as Fetcher });
    for (const fields of ["", "ordinateName,abscissaName,bondCode,tradeNum,yield,yieldSubYtdCloseBp", "bondCode,yield"]) {
      const response = await handleRequest(new Request(
        `https://eastmoney.hasbai.xyz/data/bond-top-case?date=2026-09-09${fields ? `&fields=${fields}` : ""}`,
      ), bindings);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual(fields === "bondCode,yield"
        ? rows.map(({ bondCode, yield: value }) => ({ bondCode, yield: value }))
        : rows);
    }
    const response = await handleRequest(new Request("https://example.test/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: '{ bondTopCase(date: "2026-09-09", fields: "bondCode,yield") }' }),
    }), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { bondTopCase: rows.map(({ bondCode, yield: value }) => ({ bondCode, yield: value })) },
    });
    expect(bindingFetch).toHaveBeenCalledTimes(4);
  });

  it("recomputes the MD5 signature without exposing the cookie", () => {
    const url = new URL(
      signedDmUrl(
        "/private/path",
        "device_id=abc123; session=secret",
        { issueDate: "2026-08-29" },
        1_788_000_000_000,
      ),
    );
    expect(url.hostname).toBe("rest.innodealing.com");
    expect(url.searchParams.get("timestamp")).toBe("1788000000000");
    expect(url.searchParams.get("v")).toBe("14101");
    expect(url.searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/);
    expect(url.toString()).not.toContain("secret");
  });

  it("serves the bounded CFETS history page through the DM binding", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe(
        "/onshore-capital-side/api/comprehensive-screen/cfets/histories",
      );
      expect(url.searchParams.get("bondCode")).toBe("DR001");
      expect(url.searchParams.get("endCapitalTime")).toBe("1763308799000");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.get("v")).toBe("14101");
      expect(url.searchParams.get("qIntl")).toBe("0");
      expect(url.searchParams.get("timestamp")).toMatch(/^\d+$/);
      expect(url.searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/);
      expect(request.headers.get("Accept")).toContain("application/octet-stream");
      return cfetsHistoryResponse();
    });
    const response = await handleRequest(
      new Request(
        "https://eastmoney.hasbai.xyz/data/cfets-histories?bondCode=dr001&endCapitalTime=1763308799000&limit=2&fields=bondCode,capitalTime,weightedYield,weightedYieldUpDownValueBp",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      hasNextPage: true,
      rows: [{
        bondCode: "DR001",
        capitalTime: 1_763_308_799_000,
        weightedYield: 1.5234,
        weightedYieldUpDownValueBp: -0.25,
      }],
    });
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("retains Shibor rate fields through the public sparse projection", async () => {
    const response = await handleRequest(
      new Request("https://eastmoney.hasbai.xyz/data/cfets-histories?bondCode=ShiborO%2FN&fields=bondCode,capitalTime,weightedAvgRate,lastPrice"),
      env({ DM: { fetch: vi.fn(async () => cfetsHistoryResponse()) } as unknown as Fetcher }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {rows: Array<Record<string, unknown>>};
    expect(payload.rows[0]).toEqual({bondCode: "DR001", capitalTime: 1763308799000, weightedAvgRate: 1.51, lastPrice: 1.52});
  });

  it("serves projected broker bond registrations through the DM binding", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe(
        "/onshore-bond-primary/api/bond/project/register/paging",
      );
      expect(url.searchParams.get("pageNum")).toBe("2");
      expect(url.searchParams.get("pageSize")).toBe("50");
      expect(url.searchParams.get("startDate")).toBe("2026-08-24");
      expect(url.searchParams.get("endDate")).toBe("2026-08-28");
      expect(url.searchParams.getAll("induLevel2CodeList")).toEqual(["490100"]);
      expect(url.searchParams.getAll("registerTypeList")).toEqual(["3", "2", "5"]);
      expect(url.searchParams.get("v")).toBe("14125");
      expect(url.searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/);
      return Response.json({
        code: 0,
        data: {
          hasNextPage: true,
          list: [{
            projectFullName: "测试证券公司债券项目",
            comFullName: "测试证券股份有限公司",
            projectRegisterStatusText: "已受理",
            projectRegisterTypeText: "小公募",
            issueAmount: "120",
            provinceName: "上海",
            induLevel2Name: "证券",
            underwriterName: "测试承销商",
            regNoticeNumber: "上证函〔2026〕1号",
            projectRegisterPlatform: 3,
            registerOrFiling: 1,
            updateDate: "2026-08-27 09:30:00",
            ignoredUpstreamField: "discarded",
          }],
        },
      });
    });
    const response = await handleRequest(
      new Request(
        "https://eastmoney.hasbai.xyz/data/broker-bond-registrations?startDate=2026-08-24&endDate=2026-08-28&pageNum=2&pageSize=50&fields=projectName,issuerName,status,variety,amountYi,leadUnderwriter,noticeNumber,venue,registrationOrFiling,updateDate",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasNextPage: true,
      rows: [{
        projectName: "测试证券公司债券项目",
        issuerName: "测试证券股份有限公司",
        status: "已受理",
        variety: "小公募",
        amountYi: 120,
        leadUnderwriter: "测试承销商",
        noticeNumber: "上证函〔2026〕1号",
        venue: "上交所",
        registrationOrFiling: "注册",
        updateDate: "2026-08-27",
      }],
    });
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("keeps sparse today trades and normalizes an absent trade yield to null", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/onshore-broker-quotation-apollo/api/today/trades/stat/list",
      );
      return todayTradeResponse();
    });
    const response = await handleRequest(
      new Request(
        "https://eastmoney.hasbai.xyz/data/today-trades?limit=300&fields=bondUniCode,remainingTenor,cbYte,tradeYield,tradeYieldSubCb",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        bondUniCode: "101",
        remainingTenor: "3Y",
        cbYte: 2,
        tradeYield: 2.1,
        tradeYieldSubCb: 10,
      },
      {
        bondUniCode: "102",
        remainingTenor: "2Y",
        cbYte: 1.9,
        tradeYield: null,
        tradeYieldSubCb: null,
      },
    ]);
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("rejects invalid CFETS history cursors before using the DM binding", async () => {
    const bindingFetch = vi.fn();
    for (const query of [
      "endCapitalTime=1763308799000",
      "bondCode=DR%20001&endCapitalTime=1763308799000",
      "bondCode=DR001&endCapitalTime=-1",
      "bondCode=DR001&endCapitalTime=1763308799000&limit=101",
    ]) {
      const response = await handleRequest(
        new Request(`https://example.test/cfets-histories?${query}`),
        env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
      );
      expect(response.status).toBe(422);
    }
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid broker registration ranges before using the DM binding", async () => {
    const bindingFetch = vi.fn();
    for (const query of [
      "startDate=2026-08-29&endDate=2026-08-28",
      "startDate=2025-01-01&endDate=2026-08-28",
      "startDate=2026-08-24&endDate=2026-08-28&pageSize=101",
    ]) {
      const response = await handleRequest(
        new Request(`https://example.test/broker-bond-registrations?${query}`),
        env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
      );
      expect(response.status).toBe(422);
    }
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});

describe("Eastmoney lightweight list parser", () => {
  it("removes the CPU-heavy market-briefing aggregation route", async () => {
    const response = await handleRequest(
      new Request("https://example.test/market-briefing/news", { method: "POST" }),
      env(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Not Found" });
  });

  it("validates the raw primary date range before any upstream request", async () => {
    const bindingFetch = vi.fn();
    const response = await handleRequest(
      new Request(
        "https://example.test/primary-issues?date=2026-08-25&startDate=2026-08-26",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "startDate 不能晚于 date" });
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("serves OMO as one raw upstream mapping", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/onshore-central-bank-moves-service/api/open-market-operation/detail/list",
      );
      expect(await request.json()).toEqual({
        startDate: "2026-07-21",
        endDate: "2026-08-25",
        selectedOperationTypes: [1, 2, 3, 4, 5],
      });
      return Response.json({
        code: 0,
        data: [
          {
            operationDate: "2026-08-25",
            operationName: "逆回购",
            duration: "7D",
            operationAmount: "1000",
            interestRate: "1.40",
          },
        ],
      });
    });
    const response = await handleRequest(
      new Request(
        "https://example.test/omo?startDate=2026-07-21&endDate=2026-08-25",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        operationDate: "2026-08-25",
        operationName: "逆回购",
        duration: "7D",
        operationAmount: 1000,
        interestRate: 1.4,
      },
    ]);
    expect(bindingFetch).toHaveBeenCalledOnce();
  });

  it("returns bounded field-level diagnostics for upstream schema mismatches", async () => {
    const response = await handleRequest(
      new Request(
        "https://example.test/omo?startDate=2026-08-25&endDate=2026-08-25",
      ),
      env({
        DM: {
          fetch: vi.fn(async () => Response.json({
            code: 0,
            data: [{
              operationDate: "2026-08-25",
              operationName: "逆回购",
              duration: "7D",
              operationAmount: "not-a-number-secret-value".repeat(10),
              interestRate: "1.40",
            }],
          })),
        } as unknown as Fetcher,
      }),
    );

    expect(response.status).toBe(503);
    const body = await response.json() as {
      detail: string;
      error: { issues: Array<Record<string, unknown>> };
    };
    expect(body).toMatchObject({
      detail: "公开市场操作上游数据格式异常",
      error: {
        code: "UPSTREAM_SCHEMA_MISMATCH",
        source: "公开市场操作",
        stage: "response_validation",
        issues: [{
          path: "0.operationAmount",
          code: "invalid_format",
          receivedType: "string",
        }],
      },
    });
    expect(String(body.error.issues[0]?.receivedValue)).toHaveLength(81);
    expect(String(body.error.issues[0]?.receivedValue).endsWith("…")).toBe(true);
  });

  it("projects only allowlisted REST fields", async () => {
    const bindingFetch = vi.fn(async () => Response.json({
      code: 0,
      data: [{
        operationDate: "2026-08-25",
        operationName: "逆回购",
        duration: "7D",
        operationAmount: 1000,
        interestRate: "1.40",
        ignoredUpstreamField: "large payload",
      }],
    }));
    const response = await handleRequest(
      new Request(
        "https://example.test/omo?startDate=2026-08-25&endDate=2026-08-25&fields=operationDate,operationAmount",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(await response.json()).toEqual([
      { operationDate: "2026-08-25", operationAmount: 1000 },
    ]);

    const invalid = await handleRequest(
      new Request(
        "https://example.test/omo?startDate=2026-08-25&endDate=2026-08-25&fields=rawPayload",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json()) as { detail: string }).toHaveProperty("detail");
  });

  it("returns bond metadata as a projected list for dynamically supplied codes", async () => {
    const bindingFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/onshore-bond-basic/api/bond/filter/simple/v3/onshore/batch",
      );
      expect(await request.json()).toEqual({ bondUniCodes: [101] });
      return Response.json({
        code: 0,
        data: [{
          bondUniCode: 101,
          bondShortName: "26测试01",
          comShortName: "测试证券",
          bondType: 37,
          bondOfferingType: 1,
          sciTechInnoBondStatus: 1,
          hundredsOfUnusedFields: "discarded",
        }],
      });
    });
    const response = await handleRequest(
      new Request(
        "https://example.test/bond-infos?codes=101&fields=bondUniCode,bondType,bondOfferingType,sciTechInnoBondStatus",
      ),
      env({ DM: { fetch: bindingFetch } as unknown as Fetcher }),
    );
    expect(await response.json()).toEqual([{
      bondUniCode: "101",
      bondType: 37,
      bondOfferingType: 1,
      sciTechInnoBondStatus: 1,
    }]);
  });

  it("returns news lists as arrays and normalizes an absent detail body", async () => {
    const issueTime = Date.parse("2026-08-31T15:00:00+08:00");
    const bindingFetch = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/sentiment/news/paging")) {
        return Response.json({
          code: 0,
          data: {
            list: [{ sentimentId: "news-1", title: "标题", issueTime }],
            hasNextPage: false,
          },
        });
      }
      if (pathname.endsWith("/news/info")) {
        return Response.json({
          code: 0,
          data: { sentimentId: "news-1", title: "标题", issueTime },
        });
      }
      throw new Error(`unexpected path ${pathname}`);
    });
    const testEnv = env({ DM: { fetch: bindingFetch } as unknown as Fetcher });
    const list = await handleRequest(
      new Request("https://example.test/news?pageSize=10"),
      testEnv,
    );
    expect(await list.json()).toEqual([{
      sentimentId: "news-1",
      title: "标题",
      time: "2026-08-31T15:00:00.000+08:00",
      tags: [],
    }]);
    const detail = await handleRequest(
      new Request("https://example.test/news/news-1"),
      testEnv,
    );
    expect(await detail.json()).toEqual({
      sentimentId: "news-1",
      title: "标题",
      time: "2026-08-31T15:00:00.000+08:00",
      tags: [],
      content: "",
    });
  });

  it("removes all eight report-specific aggregation routes", async () => {
    for (const route of [
      "omo",
      "funding",
      "government-bonds",
      "futures",
      "margin",
      "primary",
      "secondary",
      "inventory",
    ]) {
      const response = await handleRequest(
        new Request(`https://example.test/market-report/${route}`),
        env(),
      );
      expect(response.status).toBe(404);
    }
  });

  it("extracts direct article text without image-only children", () => {
    expect(articleParagraphsFromHtml(`
      <div id="ContentBody">
        <p style="display:none"><br></p>
        <p>第一段，<a href="#">链接文字</a>。</p>
        <center><img src="chart.png"></center>
        <p>第二段&amp;结尾。</p>
        <div class="ad_context3"></div>
      </div>
    `)).toEqual(["第一段，链接文字。", "第二段&结尾。"]);
  });
});
