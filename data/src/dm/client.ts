import { createHash } from "node:crypto";

import { ApiError } from "../http";
import { requireUpstreamCapacity } from "../upstream-rate-limit";
import { diagnosticSecrets, readUpstreamError, readUpstreamJson, redactDiagnosticText, responseDetails, UpstreamPayloadError, type UpstreamResponseDetails } from "../upstream-diagnostics";
import {
  decodeApiBinaryResponse,
  decodeCfetsCapitalHistoryList,
  decodeCfetsCapitalTableList,
  decodeFavoriteQuoteList,
  decodeFuturesLatestTradeList,
  decodeTodayTradeList,
} from "./proto";

export const DM_ORIGIN = "https://rest.innodealing.com";
export const DM_VERSION = "14101";
export const CFETS_HISTORIES_PATH =
  "/onshore-capital-side/api/comprehensive-screen/cfets/histories";
export const BROKER_BOND_REGISTRATIONS_PATH =
  "/onshore-bond-primary/api/bond/project/register/paging";
export const BROKER_BOND_REGISTRATIONS_VERSION = "14125";
export const SENTIMENT_NEWS_PAGING_PATH =
  "/onshore-sentiment-service-apple/api/v1/web/restructure/sentiment/news/paging";
export const SENTIMENT_NEWS_DETAIL_PATH =
  "/onshore-sentiment-service-apple/api/v1/web/news/info";
export const WECHAT_ARTICLE_LIST_PATH = "/onshore-sentiment-service-apple/api/v1/wechat/list";
export const DEFAULT_NEWS_TAB_ICON_IDS = [51] as const;
export const REPURCHASE_SOURCES: Readonly<Record<string, string>> = {
  DR: "1",
  R: "5",
  OR: "2",
  DIBO: "3",
  L: "4",
};

type DmEnv = Pick<Cloudflare.Env, "DM" | "DM_COOKIE" | "DM_LIMIT">;
type JsonObject = Record<string, unknown>;

function dmApiError(
  detail: string,
  options: {
    code: string;
    stage: string;
    path?: string;
    upstreamStatus?: number;
    upstreamResponse?: UpstreamResponseDetails;
  },
): ApiError {
  return new ApiError(503, detail, {
    code: options.code,
    source: "DM",
    stage: options.stage,
    ...(options.upstreamResponse ? { upstreamResponse: options.upstreamResponse } : {}),
    ...(options.path ? { upstreamPath: options.path } : {}),
    ...(options.upstreamStatus === undefined
      ? {}
      : { upstreamStatus: options.upstreamStatus }),
  });
}

function jsonObject(value: unknown, label: string): JsonObject {
  // The transport already parsed JSON. Check its container without cloning
  // every unexposed upstream field; public DTOs are validated in contracts.ts.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw dmApiError(`DM ${label}格式无效`, {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
    });
  }
  return value as JsonObject;
}

function jsonObjectRows(value: unknown): JsonObject[] {
  return requiredJsonObjectRows(value, "列表");
}

function requiredJsonObjectRows(value: unknown, label: string): JsonObject[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw dmApiError(`DM ${label}格式无效`, {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
    });
  }
  return value.filter((item) => item != null).map((item) => jsonObject(item, `${label}行`));
}

function registrationText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw dmApiError("DM 券商债券申报文本字段格式无效", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      stage: "response_validation",
    });
  }
  const result = String(value).trim();
  return result === "" || result === "-" || result === "--" ? null : result;
}

function registrationDate(value: unknown): unknown {
  const text = registrationText(value);
  if (text && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (typeof value === "number" || (text && /^\d{10,13}$/.test(text))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(milliseconds + 8 * 60 * 60 * 1_000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return text;
}

const venueNames = {
  "1": "银行间",
  "2": "深交所",
  "3": "上交所",
  "4": "中债登",
  "5": "银保监",
  "6": "北交所",
} as const;

function registrationVenue(value: unknown): string | null {
  const text = registrationText(value);
  if (text === null) return null;
  return venueNames[text as keyof typeof venueNames] ?? text;
}

function registrationKind(value: unknown): string | null {
  const text = registrationText(value);
  if (text === null) return null;
  return ({ "1": "注册", "2": "备案" } as const)[
    text as "1" | "2"
  ] ?? text;
}

function deviceId(cookie: string): string {
  const match = /(?:^|;\s*)device_id=([^;]+)/.exec(cookie);
  if (!match?.[1]) throw new ApiError(503, "DM_COOKIE must include device_id");
  return match[1];
}

function signatureValue(value: string | number | boolean | readonly unknown[]): string {
  return Array.isArray(value) ? value.map(String).join("") : String(value);
}

export function signedDmUrl(
  path: string,
  cookie: string,
  parameters: Readonly<Record<string, string | number | boolean | readonly unknown[]>> = {},
  now = Date.now(),
  version = DM_VERSION,
): string {
  const signed: Record<string, string | number | boolean | readonly unknown[]> = {
    ...parameters,
    timestamp: String(now),
    v: version,
    qIntl: "0",
  };
  const values = Object.keys(signed)
    .sort()
    .map((key) => signatureValue(signed[key] ?? ""))
    .join("");
  const sign = createHash("md5").update(values + deviceId(cookie), "utf8").digest("hex");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...signed, sign })) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.append(key, String(value));
    }
  }
  return `${DM_ORIGIN}${path}?${query}`;
}

function dmHeaders(cookie: string, accept: string, contentType: string): Headers {
  return new Headers({
    Accept: accept,
    "Content-Type": contentType,
    Cookie: cookie,
    Origin: "https://web.innodealing.com",
    Referer: "https://web.innodealing.com/quote-web/",
    "User-Agent": "Mozilla/5.0",
  });
}

async function dmFetch(
  env: DmEnv,
  path: string,
  options: {
    parameters?: Readonly<Record<string, string | number | boolean | readonly unknown[]>>;
    method?: "GET" | "POST";
    body?: JsonObject;
    contentType?: string;
    version?: string;
    accept: string;
  },
): Promise<Response> {
  const request = new Request(signedDmUrl(
    path,
    env.DM_COOKIE,
    options.parameters,
    Date.now(),
    options.version,
  ), {
    method: options.method ?? "GET",
    headers: dmHeaders(
      env.DM_COOKIE,
      options.accept,
      options.contentType ?? "application/json",
    ),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000),
  });
  await requireUpstreamCapacity(env.DM_LIMIT, "dm", "DM");
  try {
    return await env.DM.fetch(request);
  } catch (error) {
    const cause = { name: error instanceof Error ? error.name : "Error",
      message: redactDiagnosticText(error instanceof Error ? error.message : String(error), diagnosticSecrets(env.DM_COOKIE)).slice(0, 1000) };
    throw new ApiError(cause.name === "TimeoutError" ? 504 : 503, `DM ${path} fetch failed: ${cause.message}`, {
      code: cause.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR",
      source: "DM", stage: "fetch", upstreamPath: path, cause,
    });
  }
}

async function requestJson(
  env: DmEnv,
  path: string,
  options: Omit<Parameters<typeof dmFetch>[2], "accept"> = {},
): Promise<JsonObject> {
  const response = await dmFetch(env, path, {
    ...options,
    accept: "application/json, text/plain, */*",
  });
  if (!response.ok) {
    const upstreamResponse = await readUpstreamError(response, diagnosticSecrets(env.DM_COOKIE));
    throw dmApiError(`DM request failed (HTTP ${response.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      stage: "fetch",
      path,
      upstreamStatus: response.status,
      upstreamResponse,
    });
  }
  let payload: unknown;
  if (response.status === 204) return {};
  try {
    payload = await readUpstreamJson(response, diagnosticSecrets(env.DM_COOKIE));
  } catch (error) {
    throw dmApiError(`DM returned invalid JSON (HTTP ${response.status})`, {
      code: "UPSTREAM_INVALID_JSON",
      stage: "decode",
      path,
      upstreamStatus: response.status,
      ...(error instanceof UpstreamPayloadError ? { upstreamResponse: error.details } : {}),
    });
  }
  const object = jsonObject(payload ?? {}, "JSON");
  if (object.code != null && object.code !== 0 && object.code !== 200) {
    const secrets = diagnosticSecrets(env.DM_COOKIE);
    const upstreamMessage = redactDiagnosticText(String(object.message ?? ""), secrets).slice(0, 1000);
    throw new ApiError(503, `DM 返回业务错误 (${String(object.code)}): ${upstreamMessage}`, {
      code: "UPSTREAM_API_ERROR", source: "DM", stage: "decode", upstreamPath: path,
      upstreamStatus: response.status, upstreamCode: String(object.code), upstreamMessage,
      upstreamResponse: responseDetails(response, JSON.stringify(object), secrets),
    });
  }
  return object;
}

async function requestBuffer(
  env: DmEnv,
  path: string,
  options: Omit<Parameters<typeof dmFetch>[2], "accept"> = {},
): Promise<Uint8Array> {
  const response = await dmFetch(env, path, {
    ...options,
    accept: "application/octet-stream, application/json, text/plain, */*",
  });
  if (!response.ok) {
    const upstreamResponse = await readUpstreamError(response, diagnosticSecrets(env.DM_COOKIE));
    throw dmApiError(`DM request failed (HTTP ${response.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      stage: "fetch",
      path,
      upstreamStatus: response.status,
      upstreamResponse,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchCfets(
  env: DmEnv,
  issueDate: string,
  repurchaseSource: string,
): Promise<JsonObject> {
  const response = await decodeApiBinaryResponse(
    await requestBuffer(env, "/onshore-capital-side/api/comprehensive-screen/cfets", {
      parameters: { issueDate, repurchaseSource },
    }),
  );
  return {
    code: response.code,
    message: response.message,
    issueDate,
    repurchaseSource: Number(repurchaseSource),
    ...decodeCfetsCapitalTableList(response.data),
  };
}

export async function fetchCfetsHistories(
  env: DmEnv,
  bondCode: string,
  endCapitalTime: number,
  limit: number,
): Promise<JsonObject> {
  const response = await dmFetch(env, CFETS_HISTORIES_PATH, {
    parameters: { bondCode, endCapitalTime: String(endCapitalTime), limit: String(limit) },
    contentType: "text/plain",
    accept: "application/octet-stream, application/json, text/plain, */*",
  });
  const secrets = diagnosticSecrets(env.DM_COOKIE);
  if (!response.ok) {
    throw dmApiError(`DM CFETS histories returned HTTP ${response.status}`, {
      code: "UPSTREAM_HTTP_ERROR", stage: "fetch", path: CFETS_HISTORIES_PATH,
      upstreamStatus: response.status, upstreamResponse: await readUpstreamError(response, secrets),
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    const envelope = await decodeApiBinaryResponse(bytes);
    return { code: envelope.code, message: envelope.message, ...decodeCfetsCapitalHistoryList(envelope.data) };
  } catch (error) {
    const cause = { name: error instanceof Error ? error.name : "Error",
      message: redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000) };
    const original = error instanceof ApiError ? error.details : undefined;
    // For business errors the decoded envelope is more useful than compressed bytes.
    const text = original?.upstreamCode === undefined
      ? new TextDecoder().decode(bytes.subarray(0, 8193))
      : JSON.stringify({ code: original.upstreamCode, message: original.upstreamMessage });
    throw new ApiError(503, `DM CFETS histories decode failed: ${cause.message}`, {
      ...original, code: original?.code ?? "UPSTREAM_DECODE_ERROR", source: "DM", stage: "decode",
      upstreamStatus: response.status, upstreamPath: CFETS_HISTORIES_PATH, cause,
      ...(original?.upstreamMessage ? { upstreamMessage: redactDiagnosticText(original.upstreamMessage, secrets) } : {}),
      upstreamResponse: responseDetails(response, text, secrets, original?.upstreamCode === undefined && bytes.length > 8192),
    });
  }
}

export function fetchBondTopCase(env: DmEnv, issueDate: string): Promise<JsonObject> {
  return requestJson(env, "/onshore-bond-price-apollo/api/rate/matrix/top-case", {
    parameters: { issueDate, businessModule: "3", activeBondType: "2" },
  });
}

export async function fetchFuturesLatest(env: DmEnv): Promise<JsonObject> {
  const response = await decodeApiBinaryResponse(
    await requestBuffer(
      env,
      "/onshore-futures-contract/api/futures-comprehensive/futures-trade/latest-list",
    ),
  );
  return {
    code: response.code,
    message: response.message,
    ...decodeFuturesLatestTradeList(response.data),
  };
}

function previousWeekday(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) {
    value.setUTCDate(value.getUTCDate() - 1);
  }
  return value.toISOString().slice(0, 10);
}

export function fetchPrimaryIssues(
  env: DmEnv,
  current: string,
  startDate?: string,
): Promise<JsonObject> {
  return requestJson(env, "/onshore-bond-primary/api/credit-primary-issue/page", {
    method: "POST",
    body: {
      areaUniCodeList: [], bondExtRatingFilterMappingList: [],
      bondFilterTypeList: [16, 17, 18], bondIssueStatus: [], bondThemeList: [],
      bondUniCodeList: [], businessFilterNatureList: [], comExtRatingFilterMappingList: [],
      crossMarketDedupStatus: 1, dateType: 2, embeddedOptionList: [],
      endDate: current, endTenorUnit: 3, induLevel2CodeList: [], pageSize: 500,
      pcaFilterRatingMappingList: [], secondMarketList: [],
      startDate: startDate ?? previousWeekday(current), startTenorUnit: 3,
      tenorTags: [], yyScoreList: [], bondTypeList: [], dmScoreValues: [],
      dmIndustryCodes: [], paymentOrders: [], industryThirdCodeList: [],
    },
  });
}

export async function fetchBrokerBondRegistrations(
  env: DmEnv,
  startDate: string,
  endDate: string,
  pageNum: number,
  pageSize: number,
): Promise<JsonObject> {
  const payload = await requestJson(env, BROKER_BOND_REGISTRATIONS_PATH, {
    version: BROKER_BOND_REGISTRATIONS_VERSION,
    parameters: {
      pageNum,
      pageSize,
      startDate,
      endDate,
      induLevel2CodeList: ["490100"],
      registerTypeList: [3, 2, 5],
    },
  });
  const data = jsonObject(payload.data ?? payload.datas ?? {}, "券商债券申报 data");
  const rows = requiredJsonObjectRows(data.list, "券商债券申报 list").map((row) => ({
    projectName: registrationText(row.projectFullName),
    issuerName: registrationText(row.comFullName),
    status: registrationText(row.projectRegisterStatusText),
    variety: registrationText(row.projectRegisterTypeText),
    amountYi: row.issueAmount,
    region: registrationText(row.provinceName),
    industry: registrationText(row.induLevel2Name),
    leadUnderwriter: registrationText(row.underwriterName),
    noticeNumber: registrationText(row.regNoticeNumber),
    venue: registrationVenue(row.projectRegisterPlatform),
    registrationOrFiling: registrationKind(row.registerOrFiling),
    updateDate: registrationDate(row.updateDate),
  }));
  return { hasNextPage: data.hasNextPage ?? (rows.length === 0 ? false : undefined), rows };
}

export async function fetchTodayTrades(env: DmEnv, limit = 300): Promise<JsonObject> {
  const response = await decodeApiBinaryResponse(
    await requestBuffer(env, "/onshore-broker-quotation-apollo/api/today/trades/stat/list", {
      parameters: { limit: String(limit), offset: "0" },
      method: "POST",
      body: {
        sort: { sortProperty: "remainingTenorDay", sortDirection: "DESC" },
        schemaIds: [31694],
      },
      contentType: "text/plain",
    }),
  );
  return { code: response.code, message: response.message, ...decodeTodayTradeList(response.data) };
}

export async function fetchFavoriteQuotes(env: DmEnv, limit = 100): Promise<JsonObject> {
  const response = await decodeApiBinaryResponse(
    await requestBuffer(
      env,
      "/onshore-broker-quotation-apollo/api/best/quotes/my-favorite/list",
      {
        parameters: { limit: String(limit), offset: "0" },
        method: "POST",
        body: {
          brokerTypes: [0, 999],
          sort: { sortProperty: "remainingTenorDay", sortDirection: "ASC" },
          validQuoteStatus: 0,
          schemaIds: [31693],
          isSnapshot: 0,
        },
        contentType: "text/plain",
      },
    ),
  );
  return { code: response.code, message: response.message, ...decodeFavoriteQuoteList(response.data) };
}

export async function fetchBondInfos(
  env: DmEnv,
  bondUniCodes: Array<string | number>,
): Promise<Array<Record<string, unknown>>> {
  const codes = [...new Set(bondUniCodes.map(Number).filter((code) => Number.isFinite(code) && code !== 0))];
  if (codes.length === 0) return [];
  const response = await requestJson(
    env,
    "/onshore-bond-basic/api/bond/filter/simple/v3/onshore/batch",
    { method: "POST", body: { bondUniCodes: codes }, contentType: "text/plain" },
  );
  return jsonObjectRows(response.data);
}

function shanghaiIsoFromEpoch(value: unknown): string | undefined {
  const epoch = Number(value);
  if (!Number.isFinite(epoch)) return undefined;
  return new Date(epoch + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))];
}

function sentimentTags(row: JsonObject): string[] {
  const values: unknown[] = [];
  for (const item of jsonObjectRows(row.newsTagsDTOList)) {
    values.push(item.newsThirdTagName);
  }
  for (const item of jsonObjectRows(row.newsAllTagsDTOS)) {
    values.push(item.trdTagName);
  }
  for (const item of jsonObjectRows(row.topicDTOList)) values.push(item.topicName);
  for (const item of jsonObjectRows(row.rateBondTopicDTOList)) values.push(item.topicName);
  return uniqueStrings(values);
}

function originalLink(html: unknown): string | undefined {
  if (typeof html !== "string") return undefined;
  const match = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html);
  if (!match?.[1]) return undefined;
  try {
    const url = new URL(match[1].trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function compactSentimentNews(row: JsonObject, includeContent = false): JsonObject {
  const result: JsonObject = {
    sentimentId: row.sentimentId,
    newsId: row.newsId,
    title: row.title ?? row.sentimentTitle,
    time: shanghaiIsoFromEpoch(row.issueTime),
    tags: sentimentTags(row),
  };
  if (row.newsImportance !== undefined && row.newsImportance !== null) {
    result.important = Number(row.newsImportance) === 2;
  }
  if (includeContent) {
    result.content = typeof row.content === "string"
      ? row.content.replace(/\n{3,}/g, "\n\n").trim()
      : "";
    result.link = originalLink(row.contentHtml);
  }
  for (const key in result) {
    const value = result[key];
    if (value === undefined || value === null || value === "" ||
        (Array.isArray(value) && value.length === 0)) delete result[key];
  }
  return result;
}

function compactWechatArticle(row: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries({
      sentimentId: row.sentimentId,
      title: row.title,
      accountName: row.siteName,
      time: shanghaiIsoFromEpoch(row.issueTime),
      url: row.newsUrl,
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export async function fetchNewsList(
  env: DmEnv,
  options: {
    pageSize?: number;
    importanceStatus?: number;
    international?: number;
    tabIconIds?: readonly number[] | null;
    startPageId?: string;
    endPageId?: string;
  } = {},
): Promise<JsonObject> {
  const body: JsonObject = {
    importanceStatus: options.importanceStatus ?? 0,
    international: options.international ?? 0,
    pageSize: options.pageSize ?? 50,
  };
  if (options.tabIconIds !== null) body.tabIconIdSet = options.tabIconIds ?? DEFAULT_NEWS_TAB_ICON_IDS;
  if (options.startPageId) body.startPageId = options.startPageId;
  if (options.endPageId) body.endPageId = options.endPageId;
  const response = await requestJson(env, SENTIMENT_NEWS_PAGING_PATH, {
    method: "POST", body, contentType: "text/plain",
  });
  const data = jsonObject(response.data ?? {}, "新闻列表 data");
  const rows = jsonObjectRows(data.list);
  return {
    code: response.code, message: response.message,
    hasPreviousPage: data.hasPreviousPage, hasNextPage: data.hasNextPage,
    pageSize: data.pageSize, startPageId: data.startPageId, endPageId: data.endPageId,
    list: rows.map((row) => compactSentimentNews(row)),
  };
}

export async function fetchNewsDetail(
  env: DmEnv,
  options: { sentimentId?: string; newsId?: string },
): Promise<{ code: unknown; message: unknown; data: JsonObject }> {
  if (!options.sentimentId && !options.newsId) throw new ApiError(422, "sentiment_id or news_id required");
  const response = await requestJson(env, SENTIMENT_NEWS_DETAIL_PATH, {
    parameters: options.sentimentId
      ? { sentimentId: options.sentimentId }
      : { newsId: options.newsId ?? "" },
  });
  return {
    code: response.code,
    message: response.message,
    data: compactSentimentNews(jsonObject(response.data, "新闻详情 data"), true),
  };
}

export async function fetchWechatArticles(
  env: DmEnv,
  options: {
    pageSize?: number;
    onlySubscription?: boolean;
    startPageId?: string;
    endPageId?: string;
  } = {},
): Promise<JsonObject> {
  const body: JsonObject = {
    pageSize: options.pageSize ?? 50,
    onlySubscription: options.onlySubscription ?? true,
  };
  if (options.startPageId) body.startPageId = options.startPageId;
  if (options.endPageId) body.endPageId = options.endPageId;
  const response = await requestJson(env, WECHAT_ARTICLE_LIST_PATH, {
    method: "POST", body, contentType: "text/plain",
  });
  const data = jsonObject(response.data ?? {}, "公众号文章 data");
  const rows = jsonObjectRows(data.list);
  return {
    code: response.code, message: response.message,
    hasPreviousPage: data.hasPreviousPage, hasNextPage: data.hasNextPage,
    pageSize: data.pageSize, startPageId: data.startPageId, endPageId: data.endPageId,
    list: rows.map(compactWechatArticle),
  };
}

export async function fetchOmo(
  env: DmEnv,
  startDate: string,
  endDate: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await requestJson(
    env,
    "/onshore-central-bank-moves-service/api/open-market-operation/detail/list",
    {
      method: "POST",
      body: { startDate, endDate, selectedOperationTypes: [1, 2, 3, 4, 5] },
      contentType: "text/plain",
    },
  );
  return jsonObjectRows(response.data);
}
