import { describe, expect, it, vi } from "vitest";

import { handleRequest } from "../src/app";
import { getCamelSession } from "../src/camel/client";
import { fetchMarginHistory } from "../src/eastmoney";
import { allowRateLimits } from "./rate-limit-bindings";

const choiceTable = () => Response.json({ function: "CSS", fields: [], rows: [] }, {
  headers: { "X-Choice-Rpc-Version": "choice.rpc.v1" },
});

describe("upstream rate limits", () => {
  it("uses separate function keys and rejects Choice calls before the RPC binding", async () => {
    const rpc = vi.fn(async () => choiceTable());
    const fast = { limit: vi.fn(async ({ key }: { key: string }) => ({ success: key !== "css" })) } as unknown as RateLimit;
    const other = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const env = {
      ...allowRateLimits(), CHOICE_FAST_LIMIT: fast, CHOICE_OTHER_LIMIT: other,
      CHOICE_RPC: { fetch: rpc }, CHOICE_RPC_TOKEN: "fixture",
    } as unknown as Cloudflare.Env;

    const css = await handleRequest(new Request("https://test/data/choice/css?codes=000001.SH&indicators=CLOSE"), env);
    expect(css.status).toBe(429);
    expect(css.headers.get("Retry-After")).toBe("60");
    expect(await css.json()).toMatchObject({ error: { code: "RATE_LIMITED", source: "Choice" } });
    const edb = await handleRequest(new Request("https://test/data/choice/edb?edbIds=E1000172&startDate=2026-09-01&endDate=2026-09-02"), env);
    expect(edb.status).toBe(429);
    expect(fast.limit).toHaveBeenCalledWith({ key: "css" });
    expect(other.limit).toHaveBeenCalledWith({ key: "edb" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("also protects GraphQL Choice calls and DM before upstream execution", async () => {
    const rpc = vi.fn(async () => choiceTable());
    const dm = vi.fn(async () => Response.json({ code: 0, data: [] }));
    const env = {
      ...allowRateLimits(),
      CHOICE_FAST_LIMIT: { limit: vi.fn(async () => ({ success: false })) },
      DM_LIMIT: { limit: vi.fn(async () => ({ success: false })) },
      CHOICE_RPC: { fetch: rpc }, CHOICE_RPC_TOKEN: "fixture",
      DM: { fetch: dm }, DM_COOKIE: "device_id=fixture",
    } as unknown as Cloudflare.Env;

    const graphql = await handleRequest(new Request("https://test/data/graphql", {
      method: "POST", body: JSON.stringify({ query: '{ choiceCss(codes: "000001.SH", indicators: "CLOSE") { rows } }' }),
    }), env);
    expect(graphql.status).toBe(200);
    expect(await graphql.json()).toMatchObject({ data: { choiceCss: null }, errors: [{
      message: expect.stringContaining("Choice"),
      extensions: { code: "RATE_LIMITED", status: 429, retryAfterSeconds: 60 },
    }] });
    const dmResponse = await handleRequest(new Request("https://test/data/bond-top-case?date=2026-09-01"), env);
    expect(dmResponse.status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
    expect(dm).not.toHaveBeenCalled();
  });

  it("stops Eastmoney, ChinaMoney, and CAMEL before any network call", async () => {
    const denied = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    const camel = vi.fn();
    try {
      await expect(fetchMarginHistory("2026-09-01", { EASTMONEY_LIMIT: denied })).rejects.toMatchObject({ status: 429 });
      const china = await handleRequest(new Request("https://test/data/chinamoney/shibor"), {
        ...allowRateLimits(), CHINAMONEY_LIMIT: denied,
      } as Cloudflare.Env);
      expect(china.status).toBe(429);
      await expect(getCamelSession({
        CAMEL: { fetch: camel } as unknown as Fetcher,
        CAMEL_LIMIT: denied,
        CAMEL_USERNAME: "fixture", CAMEL_PASSWORD: "fixture",
        CLOUDFLARE_ACCOUNT_ID: "5cecc63c78acf8f5473f8745f4244448", AI_GATEWAY_ID: "default", CF_AIG_TOKEN: "fixture",
      }, {
        cache: { match: async () => undefined, put: async () => undefined, delete: async () => false },
      })).rejects.toMatchObject({ status: 429 });
      expect(denied.limit).toHaveBeenCalledTimes(3);
      expect(network).not.toHaveBeenCalled();
      expect(camel).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
