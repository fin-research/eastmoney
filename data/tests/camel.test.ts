import { Buffer } from "node:buffer";
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CAMEL_SESSION_CACHE_URL,
  type CamelSession,
  type CamelSessionCache,
  encryptCamelPassword,
  getCamelSession,
  requestCamelData,
} from "../src/camel/client";
import { allowRateLimits } from "./rate-limit-bindings";

const NOW = 1_800_000_000_000;
const TEST_PASSWORD = "local-test-password";

class MemorySessionCache implements CamelSessionCache {
  readonly delete = vi.fn(async () => {
    const existed = this.response !== undefined;
    this.response = undefined;
    return existed;
  });

  readonly match = vi.fn(async () => this.response?.clone());

  readonly put = vi.fn(async (_request: RequestInfo | URL, response: Response) => {
    this.response = response.clone();
  });

  response?: Response;
}

function accessToken(now = NOW): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS512" })}.${encode({
    iat: Math.floor(now / 1_000),
    user_token_info: { timeout: 28_800 },
  })}.signature`;
}

function aiOutput(code: string): Response {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ code }) }],
      },
    ],
  });
}

function testEnv(camelFetch: typeof fetch): Cloudflare.Env {
  const unavailable = { fetch: vi.fn(async () => new Response(null, { status: 503 })) };
  return {
    DM: unavailable,
    CHOICE_RPC: unavailable,
    CAMEL: { fetch: camelFetch },
    CLOUDFLARE_ACCOUNT_ID: "5cecc63c78acf8f5473f8745f4244448",
    AI_GATEWAY_ID: "default",
    DM_COOKIE: "test",
    CHOICE_RPC_TOKEN: "test",
    CF_AIG_TOKEN: "ai-token",
    CAMEL_USERNAME: "test-user",
    CAMEL_PASSWORD: TEST_PASSWORD,
    CAMEL_LIMIT: allowRateLimits().CAMEL_LIMIT,
  } as unknown as Cloudflare.Env;
}

function captchaResponse(key = "captcha-key"): Response {
  return Response.json({
    code: 200,
    success: true,
    data: { pictureCheckCode: "aW1hZ2U=", pictureCheckKey: key },
  });
}

function loginResponse(tokenName = "token-name"): Response {
  return Response.json({
    code: 200,
    success: true,
    data: { accessToken: accessToken(), tokenName },
  });
}

describe("CAMEL authentication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses RSA PKCS#1 v1.5 for the password", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const encrypted = encryptCamelPassword(
      TEST_PASSWORD,
      Buffer.from(publicDer).toString("base64"),
    );
    expect(encrypted).not.toContain(TEST_PASSWORD);
    expect(
      privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(encrypted, "base64"),
      ).toString("utf8"),
    ).toBe(TEST_PASSWORD);
  });

  it("logs in once, caches only session fields, and reuses the cached session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const camelFetch = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.json() as Record<string, unknown>,
      });
      return requests.length === 1 ? captchaResponse() : loginResponse();
    });
    const aiFetch = vi.fn<typeof fetch>(async () => aiOutput("aB3"));
    const cache = new MemorySessionCache();
    const dependencies = { aiFetch, cache, now: () => NOW };

    const first = await getCamelSession(testEnv(camelFetch), dependencies);
    const second = await getCamelSession(testEnv(camelFetch), dependencies);

    expect(second).toEqual(first);
    expect(camelFetch).toHaveBeenCalledTimes(2);
    expect(aiFetch).toHaveBeenCalledOnce();
    expect(requests.map(({ path }) => path)).toEqual([
      "/security/getAuthCode",
      "/security/doLogin",
    ]);
    const loginArgs = requests[1]?.body.args as Record<string, unknown>;
    expect(loginArgs.username).toBe("test-user");
    expect(loginArgs.password).not.toBe(TEST_PASSWORD);
    expect(loginArgs.pictureCheckCode).toBe("aB3");
    expect(loginArgs.pictureCheckKey).toBe("captcha-key");
    expect(loginArgs.timeout).toBe("480");

    expect(cache.put).toHaveBeenCalledOnce();
    expect(cache.put.mock.calls[0]?.[0]).toBe(CAMEL_SESSION_CACHE_URL);
    expect(cache.response?.headers.get("Cache-Control")).toBe(
      "public, max-age=28500",
    );
    const cached = await cache.response?.clone().json() as Record<string, unknown>;
    expect(Object.keys(cached).sort()).toEqual([
      "accessToken",
      "deviceId",
      "expiresAt",
      "tokenName",
    ]);
    expect(JSON.stringify(cached)).not.toContain("test-user");
    expect(JSON.stringify(cached)).not.toContain(TEST_PASSWORD);
  });

  it("gets a fresh single-use CAPTCHA before retrying recognition", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const paths: string[] = [];
    const camelFetch = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/security/getAuthCode") {
        return captchaResponse(`key-${paths.length}`);
      }
      return paths.length === 2
        ? Response.json({ code: 400, success: false, message: "图形验证码错误" })
        : loginResponse();
    });
    let aiCall = 0;
    const aiFetch = vi.fn<typeof fetch>(async () =>
      aiOutput(++aiCall === 1 ? "bad" : "g7K"),
    );

    await expect(
      getCamelSession(testEnv(camelFetch), {
        aiFetch,
        cache: new MemorySessionCache(),
        now: () => NOW,
      }),
    ).resolves.toMatchObject({ tokenName: "token-name" });
    expect(paths).toEqual([
      "/security/getAuthCode",
      "/security/doLogin",
      "/security/getAuthCode",
      "/security/doLogin",
    ]);
    expect(aiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a credential failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let camelCall = 0;
    const camelFetch = vi.fn<typeof fetch>(async () =>
      ++camelCall === 1
        ? captchaResponse()
        : Response.json({ code: 401, success: false, message: "用户名或密码错误" }),
    );
    const aiFetch = vi.fn<typeof fetch>(async () => aiOutput("aB3"));

    const result = getCamelSession(testEnv(camelFetch), {
      aiFetch,
      cache: new MemorySessionCache(),
      now: () => NOW,
    });
    await expect(result).rejects.toMatchObject({
      name: "ApiError",
      details: { code: "UPSTREAM_AUTH_FAILED" },
    });
    expect(camelFetch).toHaveBeenCalledTimes(2);
    expect(aiFetch).toHaveBeenCalledOnce();
  });

  it("invalidates an rejected token, logs in again, and retries the business call once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cache = new MemorySessionCache();
    const oldSession: CamelSession = {
      accessToken: accessToken(),
      tokenName: "old-token-name",
      deviceId: "f6e48a8d-da7f-4735-b897-8d188b374677",
      expiresAt: NOW + 28_800_000,
    };
    await cache.put(
      CAMEL_SESSION_CACHE_URL,
      Response.json(oldSession, { headers: { "Cache-Control": "public, max-age=28000" } }),
    );
    cache.put.mockClear();
    const paths: string[] = [];
    const camelFetch = vi.fn<typeof fetch>(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (paths.length === 1) {
        expect(request.headers.get("Cookie")).toBe("dchktoken=" + oldSession.accessToken);
        return Response.json({ code: 4107, success: false, message: "token 已过期" });
      }
      if (path === "/security/getAuthCode") return captchaResponse();
      if (path === "/security/doLogin") return loginResponse("new-token-name");
      expect(request.headers.get("Cookie")).toBe("dchktoken=" + accessToken());
      return Response.json({ code: 200, success: true, data: { value: 42 } });
    });
    const aiFetch = vi.fn<typeof fetch>(async () => aiOutput("aB3"));

    await expect(
      requestCamelData(
        testEnv(camelFetch),
        "/portfolio/query",
        { page: 1 },
        z.object({ value: z.number() }),
        { aiFetch, cache, now: () => NOW },
      ),
    ).resolves.toEqual({ value: 42 });
    expect(paths).toEqual([
      "/portfolio/query",
      "/security/getAuthCode",
      "/security/doLogin",
      "/portfolio/query",
    ]);
    expect(cache.delete).toHaveBeenCalledWith(CAMEL_SESSION_CACHE_URL);
    expect(aiFetch).toHaveBeenCalledOnce();
  });

  it("rejects paths that could bypass the configured VPC origin", async () => {
    const camelFetch = vi.fn<typeof fetch>();
    await expect(
      requestCamelData(
        testEnv(camelFetch),
        "//attacker.example/query",
        {},
        z.unknown(),
      ),
    ).rejects.toThrow("CAMEL path must be an absolute path without an origin");
    expect(camelFetch).not.toHaveBeenCalled();
  });
});
