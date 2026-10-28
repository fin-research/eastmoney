import { Buffer } from "node:buffer";
import { constants, publicEncrypt } from "node:crypto";

import { z } from "zod";

import { generateAiGatewayObject } from "../ai-gateway";
import { ApiError } from "../http";
import { requireUpstreamCapacity } from "../upstream-rate-limit";

export const CAMEL_ORIGIN = "http://10.6.88.192:7000";
export const CAMEL_SESSION_CACHE_URL =
  "https://eastmoney.hasbai.xyz/__internal/camel/session/v1";

const CAMEL_PUBLIC_KEY_SPKI_BASE64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDQUDdkHri8QotAJ/GqIZaxE1Vpv1b04LX3NCX64z3DSrAmL8iSHhimNnwOk0iPgI2TV50IKWjy0wLq+ziyMi27xAFvk8T0U1ma9aAn+qmmeKLNK9r0B9sv7Jvv0bbpA9z8sGChFLdf1V624T6s5xlJR2LD1hVIlG1S1s1cNYN6awIDAQAB";
const CAMEL_LOGIN_TIMEOUT_MINUTES = "480";
const CAMEL_SESSION_REFRESH_MARGIN_SECONDS = 5 * 60;
const MAX_CAMEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTCHA_ATTEMPTS = 3;
const SESSION_FAILURE_CODES = new Set([-1, -2, -3, 2001, 4104, 4107]);

export type CamelEnv = Pick<
  Cloudflare.Env,
  | "CAMEL"
  | "CAMEL_USERNAME"
  | "CAMEL_PASSWORD"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "AI_GATEWAY_ID"
  | "CF_AIG_TOKEN"
  | "CAMEL_LIMIT"
>;

export interface CamelSession {
  accessToken: string;
  tokenName: string;
  deviceId: string;
  expiresAt: number;
}

export interface CamelSessionCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface CamelDependencies {
  aiFetch?: typeof fetch;
  cache?: CamelSessionCache;
  now?: () => number;
}

interface CamelEnvelope {
  code?: number | string;
  data?: unknown;
  message?: string | null;
  msg?: string | null;
  success?: boolean;
}

const camelEnvelopeSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    data: z.unknown().optional(),
    message: z.string().nullable().optional(),
    msg: z.string().nullable().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

const captchaEnvelopeSchema = camelEnvelopeSchema.extend({
  data: z.object({
    pictureCheckCode: z.string().min(1).max(1_500_000),
    pictureCheckKey: z.string().min(1).max(256),
  }),
});

const loginEnvelopeSchema = camelEnvelopeSchema.extend({
  data: z.object({
    accessToken: z.string().min(1).max(16_384),
    tokenName: z.string().min(1).max(512),
  }),
});

const cachedSessionSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    tokenName: z.string().min(1).max(512),
    deviceId: z.uuid(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const jwtPayloadSchema = z
  .object({
    iat: z.number().int().positive(),
    user_token_info: z.object({
      timeout: z.number().int().positive().max(24 * 60 * 60),
    }),
  })
  .passthrough();

const captchaRecognitionSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9]{3,6}$/),
  })
  .strict();

function camelApiError(
  detail: string,
  options: {
    code: string;
    stage: string;
    path?: string;
    upstreamStatus?: number;
  },
): ApiError {
  return new ApiError(503, detail, {
    code: options.code,
    source: "CAMEL",
    stage: options.stage,
    ...(options.path ? { upstreamPath: options.path } : {}),
    ...(options.upstreamStatus === undefined
      ? {}
      : { upstreamStatus: options.upstreamStatus }),
  });
}

async function dependenciesWithDefaults(
  dependencies: CamelDependencies,
): Promise<Required<CamelDependencies>> {
  let cache = dependencies.cache;
  if (!cache) {
    cache = await (caches as unknown as CacheStorage).open("camel-session-v1");
  }
  return {
    aiFetch: dependencies.aiFetch ?? fetch,
    cache,
    now: dependencies.now ?? Date.now,
  };
}

function requestHeader(deviceId: string, tokenName = ""): Record<string, string> {
  return {
    deviceId,
    sysNo: "CAMEL",
    traceId: crypto.randomUUID().replaceAll("-", ""),
    transactionId: "",
    userMark: "",
    ...(tokenName ? { tokenName } : {}),
  };
}

function envelopeMessage(envelope: CamelEnvelope): string {
  return envelope.message?.trim() || envelope.msg?.trim() || "CAMEL request failed";
}

function numericCode(envelope: CamelEnvelope): number | null {
  const parsed = Number(envelope.code);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSuccess(envelope: CamelEnvelope): boolean {
  return envelope.success !== false && (numericCode(envelope) === 200 || (envelope.code === undefined && envelope.success === true));
}

function validatePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("CAMEL path must be an absolute path without an origin");
  }
  const url = new URL(path, CAMEL_ORIGIN);
  if (url.origin !== CAMEL_ORIGIN) {
    throw new Error("CAMEL path must not override the configured origin");
  }
  return `${url.pathname}${url.search}`;
}

async function readJsonBounded(response: Response, path: string): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CAMEL_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw camelApiError("CAMEL response is too large", {
      code: "UPSTREAM_RESPONSE_TOO_LARGE",
      stage: "decode",
      path,
      upstreamStatus: response.status,
    });
  }
  if (!response.body) {
    throw camelApiError("CAMEL returned an empty response", {
      code: "UPSTREAM_INVALID_JSON",
      stage: "decode",
      path,
      upstreamStatus: response.status,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAMEL_RESPONSE_BYTES) {
      await reader.cancel("CAMEL response too large");
      throw camelApiError("CAMEL response is too large", {
        code: "UPSTREAM_RESPONSE_TOO_LARGE",
        stage: "decode",
        path,
        upstreamStatus: response.status,
      });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw camelApiError("CAMEL returned invalid JSON", {
      code: "UPSTREAM_INVALID_JSON",
      stage: "decode",
      path,
      upstreamStatus: response.status,
    });
  }
}

async function postCamel(
  env: CamelEnv,
  path: string,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<unknown> {
  const safePath = validatePath(path);
  let response: Response;
  await requireUpstreamCapacity(env.CAMEL_LIMIT, "camel", "CAMEL");
  try {
    response = await env.CAMEL.fetch(
      new Request(`${CAMEL_ORIGIN}${safePath}`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          ...(accessToken ? { Cookie: `dchktoken=${accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }),
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw error;
    throw camelApiError("CAMEL request failed", {
      code: "UPSTREAM_NETWORK_ERROR",
      stage: "fetch",
      path: safePath,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw camelApiError(`CAMEL request failed (HTTP ${response.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      stage: "fetch",
      path: safePath,
      upstreamStatus: response.status,
    });
  }
  return readJsonBounded(response, safePath);
}

export function encryptCamelPassword(
  password: string,
  publicKeySpkiBase64 = CAMEL_PUBLIC_KEY_SPKI_BASE64,
): string {
  return publicEncrypt(
    { key: Buffer.from(publicKeySpkiBase64, "base64"), format: "der", type: "spki", padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  ).toString("base64");
}

function tokenExpiresAt(accessToken: string, now: number): number {
  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) {
    throw camelApiError("CAMEL returned an invalid access token", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path: "/security/doLogin",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    throw camelApiError("CAMEL returned an invalid access token", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path: "/security/doLogin",
    });
  }
  const payload = jwtPayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw camelApiError("CAMEL returned an invalid access token", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path: "/security/doLogin",
    });
  }
  const expiresAt = (payload.data.iat + payload.data.user_token_info.timeout) * 1_000;
  if (
    expiresAt <= now + CAMEL_SESSION_REFRESH_MARGIN_SECONDS * 1_000 ||
    expiresAt > now + 24 * 60 * 60 * 1_000
  ) {
    throw camelApiError("CAMEL returned an unusable access token lifetime", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path: "/security/doLogin",
    });
  }
  return expiresAt;
}

async function recognizeCaptcha(
  env: CamelEnv,
  pictureBase64: string,
  aiFetch: typeof fetch,
): Promise<string> {
  const result = await generateAiGatewayObject(
    {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID,
      token: env.CF_AIG_TOKEN,
    },
    [
      {
        role: "system",
        content:
          "识别登录验证码。验证码只包含大小写英文字母和数字，大小写敏感。只按 JSON Schema 返回图片中的验证码，不解释、不猜测图片外的信息。",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "读取这张验证码图片中的全部字符。" },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${pictureBase64}`,
            detail: "high",
          },
        ],
      },
    ],
    captchaRecognitionSchema,
    "camel_captcha",
    {
      metadata: {
        business: "camel_auth",
        prompt_version: "captcha-v1",
      },
      promptCacheKey: "camel-captcha:v1",
      requestTimeoutMs: 30_000,
      taskType: "summary",
    },
    aiFetch,
  );
  return result.code;
}

async function readCachedSession(
  cache: CamelSessionCache,
  now: number,
): Promise<CamelSession | null> {
  try {
    const response = await cache.match(CAMEL_SESSION_CACHE_URL);
    if (!response) return null;
    const parsed = cachedSessionSchema.safeParse(await response.json());
    if (
      !parsed.success ||
      parsed.data.expiresAt <= now + CAMEL_SESSION_REFRESH_MARGIN_SECONDS * 1_000
    ) {
      await cache.delete(CAMEL_SESSION_CACHE_URL);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "camel_session_cache_read_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return null;
  }
}

async function writeCachedSession(
  cache: CamelSessionCache,
  session: CamelSession,
  now: number,
): Promise<void> {
  const maxAge = Math.floor((session.expiresAt - now) / 1_000) -
    CAMEL_SESSION_REFRESH_MARGIN_SECONDS;
  if (maxAge <= 0) return;
  try {
    await cache.put(
      CAMEL_SESSION_CACHE_URL,
      Response.json(session, {
        headers: {
          "Cache-Control": `public, max-age=${maxAge}`,
          "Content-Type": "application/json",
        },
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "camel_session_cache_write_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

function isCaptchaFailure(envelope: CamelEnvelope): boolean {
  return /验证码|captcha|check\s*code/i.test(envelopeMessage(envelope));
}

function requiredSecret(label: string, value: string): string {
  if (!value) {
    throw camelApiError(`CAMEL ${label} secret is not configured`, {
      code: "UPSTREAM_AUTH_NOT_CONFIGURED",
      stage: "configuration",
    });
  }
  return value;
}

async function deleteCachedSession(cache: CamelSessionCache): Promise<void> {
  try {
    await cache.delete(CAMEL_SESSION_CACHE_URL);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "camel_session_cache_delete_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

async function loginCamel(
  env: CamelEnv,
  dependencies: Required<CamelDependencies>,
): Promise<CamelSession> {
  const username = requiredSecret("username", env.CAMEL_USERNAME);
  const password = requiredSecret("password", env.CAMEL_PASSWORD);
  for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt += 1) {
    const deviceId = crypto.randomUUID();
    const captchaPayload = await postCamel(env, "/security/getAuthCode", {
      header: requestHeader(deviceId),
    });
    const captcha = captchaEnvelopeSchema.safeParse(captchaPayload);
    if (!captcha.success || !isSuccess(captcha.data)) {
      throw camelApiError("CAMEL captcha response is invalid", {
        code: "UPSTREAM_SCHEMA_MISMATCH",
        stage: "response_validation",
        path: "/security/getAuthCode",
      });
    }

    const pictureCheckCode = await recognizeCaptcha(
      env,
      captcha.data.data.pictureCheckCode,
      dependencies.aiFetch,
    );
    const loginPayload = await postCamel(env, "/security/doLogin", {
      args: {
        password: encryptCamelPassword(password),
        username,
        pictureCheckCode,
        timeout: CAMEL_LOGIN_TIMEOUT_MINUTES,
        pictureCheckKey: captcha.data.data.pictureCheckKey,
      },
      header: requestHeader(deviceId),
    });
    const envelope = camelEnvelopeSchema.safeParse(loginPayload);
    if (!envelope.success) {
      throw camelApiError("CAMEL login response is invalid", {
        code: "UPSTREAM_SCHEMA_MISMATCH",
        stage: "response_validation",
        path: "/security/doLogin",
      });
    }
    if (!isSuccess(envelope.data)) {
      if (isCaptchaFailure(envelope.data) && attempt < MAX_CAPTCHA_ATTEMPTS) {
        console.warn(JSON.stringify({ event: "camel_captcha_retry", attempt }));
        continue;
      }
      throw camelApiError(
        isCaptchaFailure(envelope.data)
          ? "CAMEL captcha recognition failed"
          : "CAMEL login failed",
        {
          code: isCaptchaFailure(envelope.data)
            ? "CAPTCHA_RECOGNITION_FAILED"
            : "UPSTREAM_AUTH_FAILED",
          stage: "login",
          path: "/security/doLogin",
        },
      );
    }
    const login = loginEnvelopeSchema.safeParse(loginPayload);
    if (!login.success) {
      throw camelApiError("CAMEL login response is invalid", {
        code: "UPSTREAM_SCHEMA_MISMATCH",
        stage: "response_validation",
        path: "/security/doLogin",
      });
    }
    const session: CamelSession = {
      accessToken: login.data.data.accessToken,
      tokenName: login.data.data.tokenName,
      deviceId,
      expiresAt: tokenExpiresAt(login.data.data.accessToken, dependencies.now()),
    };
    await writeCachedSession(dependencies.cache, session, dependencies.now());
    console.log(JSON.stringify({ event: "camel_login_succeeded", attempt }));
    return session;
  }
  throw camelApiError("CAMEL captcha recognition failed", {
    code: "CAPTCHA_RECOGNITION_FAILED",
    stage: "login",
    path: "/security/doLogin",
  });
}

export async function getCamelSession(
  env: CamelEnv,
  dependencies: CamelDependencies = {},
): Promise<CamelSession> {
  const resolved = await dependenciesWithDefaults(dependencies);
  const cached = await readCachedSession(resolved.cache, resolved.now());
  return cached ?? loginCamel(env, resolved);
}

export async function refreshCamelSession(
  env: CamelEnv,
  dependencies: CamelDependencies = {},
): Promise<CamelSession> {
  const resolved = await dependenciesWithDefaults(dependencies);
  await deleteCachedSession(resolved.cache);
  return loginCamel(env, resolved);
}

function isSessionFailure(envelope: CamelEnvelope): boolean {
  const code = numericCode(envelope);
  if (code !== null && SESSION_FAILURE_CODES.has(code)) return true;
  return false;
}

async function requestWithSession(
  env: CamelEnv,
  path: string,
  args: Record<string, unknown>,
  session: CamelSession,
): Promise<CamelEnvelope> {
  const payload = await postCamel(
    env,
    path,
    {
      args,
      header: requestHeader(session.deviceId, session.tokenName),
    },
    session.accessToken,
  );
  const envelope = camelEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw camelApiError("CAMEL response is invalid", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path,
    });
  }
  return envelope.data;
}

export async function requestCamelData<OUTPUT>(
  env: CamelEnv,
  path: string,
  args: Record<string, unknown>,
  dataSchema: z.ZodType<OUTPUT>,
  dependencies: CamelDependencies = {},
): Promise<OUTPUT> {
  const safePath = validatePath(path);
  const resolved = await dependenciesWithDefaults(dependencies);
  let session = await getCamelSession(env, resolved);
  let envelope = await requestWithSession(env, safePath, args, session);
  if (isSessionFailure(envelope)) {
    await deleteCachedSession(resolved.cache);
    session = await loginCamel(env, resolved);
    envelope = await requestWithSession(env, safePath, args, session);
  }
  if (!isSuccess(envelope)) {
    throw camelApiError("CAMEL business request failed", {
      code: isSessionFailure(envelope) ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_BUSINESS_ERROR",
      stage: "upstream_response",
      path: safePath,
    });
  }
  const data = dataSchema.safeParse(envelope.data);
  if (!data.success) {
    throw camelApiError("CAMEL response data is invalid", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
      path: safePath,
    });
  }
  return data.data;
}


/** Protocol variants used by the fixed internal CAMEL adapter. Never accepts a caller-supplied URL. */
export interface CamelResourceRequest {
  method?: "GET" | "POST";
  json?: unknown;
  form?: FormData;
  stream?: { body: ReadableStream<Uint8Array>; contentType: string };
  withHeader?: boolean;
}

export async function requestCamelResource<OUTPUT>(
  env: CamelEnv,
  path: string,
  input: CamelResourceRequest,
  schema: z.ZodType<OUTPUT>,
  dependencies: CamelDependencies = {},
): Promise<OUTPUT> {
  const safePath = validatePath(path);
  const resolved = await dependenciesWithDefaults(dependencies);
  const perform = async (session: CamelSession): Promise<CamelEnvelope> => {
    await requireUpstreamCapacity(env.CAMEL_LIMIT, "camel", "CAMEL");
    const headers = new Headers({
      Accept: "application/json, text/plain, */*",
      Cookie: `dchktoken=${session.accessToken}`,
      "Menu-Name": encodeURIComponent("同业拆入"),
      Origin: CAMEL_ORIGIN,
      Referer: `${CAMEL_ORIGIN}/flowManagement/debtManagement/creditBusiness/sameIn`,
      deviceId: session.deviceId,
      sysNo: "CAMEL",
    });
    let body: BodyInit | undefined;
    if (input.stream) { body = input.stream.body; headers.set("Content-Type", input.stream.contentType); }
    else if (input.form) body = input.form;
    else if (input.method !== "GET") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(input.withHeader
        ? { ...(input.json as Record<string, unknown> ?? {}), header: requestHeader(session.deviceId, session.tokenName) }
        : input.json);
    }
    let response: Response;
    try {
      response = await env.CAMEL.fetch(new Request(`${CAMEL_ORIGIN}${safePath}`, {
        method: input.method ?? "POST", headers, body,
        ...(input.stream ? { duplex: "half" } : {}),
        redirect: "manual", signal: AbortSignal.timeout(30_000),
      }));
    } catch {
      throw camelApiError("CAMEL request result is unknown", { code: "CAMEL_RESULT_UNKNOWN", stage: "fetch", path: safePath });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw camelApiError("CAMEL request failed", { code: "CAMEL_RESULT_UNKNOWN", stage: "fetch", path: safePath, upstreamStatus: response.status });
    }
    const parsed = camelEnvelopeSchema.safeParse(await readJsonBounded(response, safePath));
    if (!parsed.success) throw camelApiError("CAMEL response is invalid", { code: "CAMEL_RESULT_UNKNOWN", stage: "decode", path: safePath });
    return parsed.data;
  };
  let session = await getCamelSession(env, resolved);
  let envelope = await perform(session);
  if (!isSuccess(envelope) && isSessionFailure(envelope)) {
    await deleteCachedSession(resolved.cache);
    if (!input.stream) {
      session = await loginCamel(env, resolved);
      envelope = await perform(session);
    }
  }
  if (!isSuccess(envelope)) throw camelApiError("CAMEL business request failed", {
    code: isSessionFailure(envelope) ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_BUSINESS_ERROR",
    stage: "upstream_response", path: safePath,
  });
  const data = schema.safeParse(envelope.data);
  if (!data.success) throw camelApiError("CAMEL response data is invalid", { code: "CAMEL_RESULT_UNKNOWN", stage: "response_validation", path: safePath });
  return data.data;
}
