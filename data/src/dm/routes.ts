import {
  fetchBrokerBondRegistrations,
  fetchBondInfos,
  fetchBondTopCase,
  fetchCfets,
  fetchCfetsHistories,
  fetchFavoriteQuotes,
  fetchFuturesLatest,
  fetchNewsDetail,
  fetchOmo,
  fetchPrimaryIssues,
  fetchTodayTrades,
  fetchWechatArticles,
  REPURCHASE_SOURCES,
} from "./client";
import { fetchNewsBatch, fetchNewsSummaries } from "./news";
import {
  brokerBondRegistrationPageSchema,
  brokerBondRegistrationSchema,
  bondInfoSchema,
  cfetsRateSchema,
  cfetsHistoryPageSchema,
  cfetsHistorySchema,
  favoriteQuoteSchema,
  futuresQuoteSchema,
  governmentBondSchema,
  newsDetailSchema,
  newsSummarySchema,
  objectProperty,
  omoOperationSchema,
  parseObject,
  parseRows,
  primaryIssueSchema,
  projectObject,
  projectRows,
  todayTradeSchema,
  wechatArticleSchema,
} from "../contracts";
import {
  ApiError,
  jsonResponse,
  normalizeCsv,
  optionalDate,
  parseDate,
  requiredParameter,
  requireMethod,
  shanghaiToday,
} from "../http";

type DmEnv = Pick<Cloudflare.Env, "DM" | "DM_COOKIE" | "DM_LIMIT">;

function integerParameter(
  parameters: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new ApiError(422, `${name} 应为整数`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new ApiError(422, `${name} 应在 ${minimum} 到 ${maximum} 之间`);
  }
  return value;
}

function booleanValue(value: string, name: string): boolean {
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new ApiError(422, `${name} 应为布尔值`);
}

function optionalBoolean(parameters: URLSearchParams, name: string): boolean | undefined {
  const value = parameters.get(name);
  return value === null ? undefined : booleanValue(value, name);
}

function parseDateTime(value: string, name: string): number {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const isoLike = value.includes("T") ? value : value.replace(" ", "T");
  const normalized = hasOffset ? isoLike : `${isoLike}+08:00`;
  const result = Date.parse(normalized);
  if (Number.isNaN(result)) throw new ApiError(422, `${name} 不是有效时间`);
  return result;
}

function optionalDateTime(parameters: URLSearchParams, name: string): number | undefined {
  const value = parameters.get(name);
  return value === null || value === "" ? undefined : parseDateTime(value, name);
}

function dateBounds(date: string): readonly [number, number] {
  const start = Date.parse(`${date}T00:00:00+08:00`);
  return [start, start + 24 * 60 * 60 * 1000 - 1];
}

export async function resolveDmData(
  request: Request,
  env: DmEnv,
  pathname: string,
) {
  const parameters = new URL(request.url).searchParams;
  if (pathname === "/cfets") {
    requireMethod(request, "GET");
    const source = (parameters.get("source") ?? "DR").toUpperCase();
    const repurchaseSource = REPURCHASE_SOURCES[source];
    if (!repurchaseSource) {
      throw new ApiError(422, `source 应为 ${JSON.stringify(Object.keys(REPURCHASE_SOURCES).sort())} 之一`);
    }
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const payload = await fetchCfets(env, date, repurchaseSource);
    const rows = parseRows(
      cfetsRateSchema,
      objectProperty(payload, "cfetsCapitalTable", "CFETS"),
      "CFETS",
    );
    return projectRows(cfetsRateSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/cfets-histories") {
    requireMethod(request, "GET");
    const bondCode = requiredParameter(parameters, "bondCode", 32).toUpperCase();
    if (!/^[A-Z0-9._/-]+$/.test(bondCode)) {
      throw new ApiError(422, "bondCode 仅支持字母、数字、点、下划线、斜线和连字符");
    }
    const endCapitalTime = integerParameter(
      parameters,
      "endCapitalTime",
      Date.now(),
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = integerParameter(parameters, "limit", 100, 1, 100);
    const payload = await fetchCfetsHistories(env, bondCode, endCapitalTime, limit);
    const page = parseObject(cfetsHistoryPageSchema, {
      hasNextPage: objectProperty(payload, "hasNextPage", "CFETS 历史资金利率"),
      rows: parseRows(cfetsHistorySchema, objectProperty(payload, "cfetsCapitalHistory", "CFETS 历史资金利率"), "CFETS 历史资金利率"),
    }, "CFETS 历史资金利率");
    return {
      hasNextPage: page.hasNextPage,
      rows: projectRows(cfetsHistorySchema, page.rows, parameters.get("fields")),
    };
  }
  if (pathname === "/bond-top-case") {
    requireMethod(request, "GET");
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const payload = await fetchBondTopCase(env, date);
    const rows = parseRows(
      governmentBondSchema,
      objectProperty(payload, "data", "国债行情"),
      "国债行情",
    );
    return projectRows(governmentBondSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/futures-latest") {
    requireMethod(request, "GET");
    const payload = await fetchFuturesLatest(env);
    const rows = parseRows(
      futuresQuoteSchema,
      objectProperty(payload, "futuresContractLatestTradeProtoList", "国债期货"),
      "国债期货",
    );
    return projectRows(futuresQuoteSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/primary-issues") {
    requireMethod(request, "GET");
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const startDate = optionalDate(parameters, "startDate");
    if (startDate && startDate > date) {
      throw new ApiError(422, "startDate 不能晚于 date");
    }
    const payload = await fetchPrimaryIssues(env, date, startDate);
    const data = objectProperty(payload, "data", "一级发行");
    const rows = parseRows(
      primaryIssueSchema,
      objectProperty(data, "list", "一级发行"),
      "一级发行",
    );
    return projectRows(primaryIssueSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/broker-bond-registrations") {
    requireMethod(request, "GET");
    const startDate = parseDate(
      requiredParameter(parameters, "startDate", 10),
      "startDate",
    );
    const endDate = parseDate(
      requiredParameter(parameters, "endDate", 10),
      "endDate",
    );
    if (startDate > endDate) {
      throw new ApiError(422, "startDate 不能晚于 endDate");
    }
    const rangeDays = Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
        86_400_000,
    );
    if (rangeDays > 366) throw new ApiError(422, "日期范围不能超过 366 天");
    const pageNum = integerParameter(parameters, "pageNum", 1, 1, 10_000);
    const pageSize = integerParameter(parameters, "pageSize", 50, 1, 100);
    const payload = await fetchBrokerBondRegistrations(env, startDate, endDate, pageNum, pageSize);
    const page = parseObject(
      brokerBondRegistrationPageSchema,
      { ...payload, rows: parseRows(brokerBondRegistrationSchema, payload.rows, "券商债券申报") },
      "券商债券申报",
    );
    return {
      hasNextPage: page.hasNextPage,
      rows: projectRows(
        brokerBondRegistrationSchema,
        page.rows,
        parameters.get("fields"),
      ),
    };
  }
  if (pathname === "/omo") {
    requireMethod(request, "GET");
    const startDate = parseDate(
      requiredParameter(parameters, "startDate", 10),
      "startDate",
    );
    const endDate = parseDate(
      requiredParameter(parameters, "endDate", 10),
      "endDate",
    );
    if (startDate > endDate) {
      throw new ApiError(422, "startDate 不能晚于 endDate");
    }
    const rows = parseRows(
      omoOperationSchema,
      await fetchOmo(env, startDate, endDate),
      "公开市场操作",
    );
    return projectRows(omoOperationSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/today-trades") {
    requireMethod(request, "GET");
    const limit = integerParameter(parameters, "limit", 300, 1, 500);
    const payload = await fetchTodayTrades(env, limit);
    const rows = parseRows(
      todayTradeSchema,
      objectProperty(payload, "list", "今日成交"),
      "今日成交",
    );
    return projectRows(todayTradeSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/favorite-quotes") {
    requireMethod(request, "GET");
    const limit = integerParameter(parameters, "limit", 100, 1, 500);
    const payload = await fetchFavoriteQuotes(env, limit);
    const rows = parseRows(
      favoriteQuoteSchema,
      objectProperty(payload, "list", "收藏报价"),
      "收藏报价",
    );
    return projectRows(favoriteQuoteSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/bond-infos") {
    requireMethod(request, "GET");
    const codes = normalizeCsv(
      requiredParameter(parameters, "codes", 8192),
      "codes",
      { maximumItems: 500 },
    ).split(",");
    const rows = parseRows(bondInfoSchema, await fetchBondInfos(env, codes), "债券基础信息");
    return projectRows(bondInfoSchema, rows, parameters.get("fields"));
  }
  if (pathname === "/news") {
    requireMethod(request, "GET");
    const detail = optionalBoolean(parameters, "detail") === true;
    const pageSize = integerParameter(parameters, "pageSize", detail ? 10 : 50, 1, detail ? 10 : 100);
    const offset = integerParameter(parameters, "offset", 0, 0, 90);
    if (offset + pageSize > 100) throw new ApiError(422, "offset + pageSize 不能超过 100");
    const tag = parameters.get("tag")?.trim() || undefined;
    const date = optionalDate(parameters, "date");
    let startTime = optionalDateTime(parameters, "startTime");
    let endTime = optionalDateTime(parameters, "endTime");
    if (date) {
      const [dateStart, dateEnd] = dateBounds(parseDate(date, "date"));
      startTime = Math.max(startTime ?? Number.NEGATIVE_INFINITY, dateStart);
      endTime = Math.min(endTime ?? Number.POSITIVE_INFINITY, dateEnd);
    }
    if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
      throw new ApiError(422, "startTime 不能晚于 endTime");
    }
    const important = optionalBoolean(parameters, "important");
    const payload = await fetchNewsSummaries(
      env,
      { pageSize: offset + pageSize, tag, important, startTime, endTime, requireComplete: detail },
    );
    const page = payload.list.slice(offset, offset + pageSize);
    if (detail) return projectRows(newsDetailSchema, await fetchNewsBatch(env, page), parameters.get("fields"));
    return projectRows(newsSummarySchema, page, parameters.get("fields"));
  }
  if (pathname.startsWith("/news/") && pathname.length > "/news/".length) {
    requireMethod(request, "GET");
    const articleId = decodeURIComponent(pathname.slice("/news/".length));
    const result = await fetchNewsDetail(env, { sentimentId: articleId });
    const detail = parseObject(
      newsDetailSchema,
      result.data,
      "DM新闻详情",
    );
    return projectObject(newsDetailSchema, detail, parameters.get("fields"));
  }
  if (pathname === "/wechat-articles") {
    requireMethod(request, "GET");
    const pageSize = integerParameter(parameters, "pageSize", 50, 1, 100);
    const onlySubscription = parameters.has("onlySubscription")
      ? booleanValue(parameters.get("onlySubscription") ?? "", "onlySubscription")
      : true;
    const payload = await fetchWechatArticles(env, {
      pageSize,
      onlySubscription,
      startPageId: parameters.get("startPageId") || undefined,
      endPageId: parameters.get("endPageId") || undefined,
    });
    const rows = parseRows(
      wechatArticleSchema,
      objectProperty(payload, "list", "DM公众号文章"),
      "DM公众号文章",
    );
    return projectRows(wechatArticleSchema, rows, parameters.get("fields"));
  }
  return null;
}

export async function handleDmRoute(
  request: Request,
  env: DmEnv,
  pathname: string,
): Promise<Response | null> {
  const data = await resolveDmData(request, env, pathname);
  return data === null ? null : jsonResponse(data);
}
