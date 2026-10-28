import { resolveChinamoneyData } from "./chinamoney";
import {
  buildSchema,
  GraphQLError,
  graphql,
  type GraphQLSchema,
} from "graphql";

import { AccessError } from './access';
import { resolveChoiceData } from "./choice/routes";
import { resolveDmData } from "./dm/routes";
import { resolveEastmoneyData } from "./eastmoney-routes";
import { resolveTradingCalendarData } from "./trading-calendar";
import {
  ApiError,
  shanghaiToday,
  textResponse,
} from "./http";

const SDL = String.raw`
  type ChoiceTableType { function: String!, fields: [String!]!, rows: [JSON!]! }
  scalar Date
  scalar JSON

  type Query {
    chinamoneyShibor(fields: String = ""): [JSON!]
    health: JSON!
    config: JSON!
    tradingDays(date: Date = null, fields: String = ""): JSON
    omo(startDate: Date!, endDate: Date!, fields: String = ""): [JSON!]
    cfets(date: Date = null, source: String = "DR", fields: String = ""): [JSON!]
    cfetsHistories(bondCode: String!, endCapitalTime: String = "", limit: Int = 100, fields: String = ""): JSON
    bondTopCase(date: Date = null, fields: String = ""): [JSON!]
    futuresLatest(fields: String = ""): [JSON!]
    primaryIssues(date: Date = null, startDate: Date = null, fields: String = ""): [JSON!]
    brokerBondRegistrations(startDate: Date!, endDate: Date!, pageNum: Int = 1, pageSize: Int = 50, fields: String = ""): JSON
    todayTrades(limit: Int = 300, fields: String = ""): [JSON!]
    favoriteQuotes(limit: Int = 100, fields: String = ""): [JSON!]
    bondInfos(codes: String!, fields: String = ""): [JSON!]
    news(pageSize: Int = null, detail: Boolean = false, offset: Int = 0, tag: String = "", date: Date = null, startTime: String = "", endTime: String = "", important: Boolean = null, fields: String = ""): [JSON!]
    newsDetail(articleId: String!, fields: String = ""): JSON
    wechatArticles(pageSize: Int = 50, onlySubscription: Boolean = true, startPageId: String = "", endPageId: String = "", fields: String = ""): [JSON!]
    industry(date: Date = null, fields: String = ""): JSON
    stockSummary(date: Date = null, fields: String = ""): JSON
    margin(date: Date = null, fields: String = ""): [JSON!]
    choiceCsd(codes: String!, indicators: String!, startDate: Date!, endDate: Date!, options: String! = ""): ChoiceTableType
    choiceCss(codes: String!, indicators: String!, options: String! = ""): ChoiceTableType
    choiceCtr(reportName: String!, indicators: String! = "", options: String! = ""): ChoiceTableType
    choiceEdb(edbIds: String!, startDate: Date!, endDate: Date!, options: String! = ""): ChoiceTableType
    choiceDataStatistics(funcName: String! = "", indicators: String! = "", startDate: Date = null, endDate: Date = null, options: String! = ""): ChoiceTableType
  }
`;

let schemaCache: GraphQLSchema | undefined;

export function getSchema(): GraphQLSchema {
  schemaCache ??= buildSchema(SDL);
  return schemaCache;
}

type GraphqlEnv = Cloudflare.Env;
type DataResolver<Result> = (
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
) => Promise<Result | null>;

const GRAPHQL_SUBREQUEST_BUDGET = 40;

function resourceCost(
  field: string,
  args: Record<string, unknown>,
): number {
  if (field === "industry") return 4;
  if (field === "stockSummary") return 2;
  if (field === "news") {
    const scans = ["date", "startTime", "endTime"].some((name) => args[name] != null && args[name] !== "") ? 20 : 1;
    return scans + (args.detail === true ? Math.min(10, Math.max(1, Number(args.pageSize ?? 10))) : 0);
  }
  return 1;
}

function resourceBudget(): {
  run: <Result>(
    field: string,
    args: Record<string, unknown>,
    action: () => Result,
  ) => Result;
} {
  let used = 0;
  return {
    run: <Result>(
      field: string,
      args: Record<string, unknown>,
      action: () => Result,
    ): Result => {
      const cost = resourceCost(field, args);
      if (used + cost > GRAPHQL_SUBREQUEST_BUDGET) {
        throw new GraphQLError(
          `GraphQL resource budget exceeded (${GRAPHQL_SUBREQUEST_BUDGET} subrequests)`,
          { extensions: { code: "QUERY_RESOURCE_LIMIT" } },
        );
      }
      used += cost;
      return action();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routeUrl(
  pathname: string,
  args: Record<string, unknown>,
): URL {
  const url = new URL(pathname, "https://graphql.data.internal");
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }
  return url;
}

async function routeData<Result>(
  resolver: DataResolver<Result>,
  env: GraphqlEnv,
  pathname: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  let data: Result | null;
  try {
    data = await resolver(new Request(routeUrl(pathname, args)), env, pathname);
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      throw new GraphQLError(error.detail, {
        originalError: error,
        extensions: { code: "RATE_LIMITED", status: 429, retryAfterSeconds: 60 },
      });
    }
    throw error;
  }
  if (data === null) throw new ApiError(404, `GraphQL resource not found: ${pathname}`);
  return data;
}

function graphiqlHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>东方财富市场数据 API - GraphiQL</title>
<link rel="stylesheet" href="https://unpkg.com/graphiql@3.8.3/graphiql.min.css">
<style>html,body,#graphiql{height:100%;margin:0}</style>
</head><body><div id="graphiql">Loading GraphiQL…</div>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script crossorigin src="https://unpkg.com/graphiql@3.8.3/graphiql.min.js"></script>
<script>
const fetcher = GraphiQL.createFetcher({url: location.href});
ReactDOM.createRoot(document.getElementById('graphiql')).render(
  React.createElement(GraphiQL, {fetcher})
);
</script></body></html>`;
}

export async function handleGraphql(
  request: Request,
  env: GraphqlEnv,
  authorizeChoice?: () => Promise<void>,
): Promise<Response> {
  if (["GET", "HEAD"].includes(request.method)) {
    return textResponse(request.method === "HEAD" ? "" : graphiqlHtml(), "text/html; charset=utf-8");
  }
  if (request.method !== "POST") {
    throw new ApiError(405, "Method Not Allowed");
  }
  let body: { query?: unknown; variables?: unknown; operationName?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new ApiError(400, "Request body is not valid JSON");
  }
  if (typeof body.query !== "string") {
    throw new ApiError(400, "GraphQL query is required");
  }

  const choiceData = async (pathname: string, args: Record<string, unknown>) => {
    try { await authorizeChoice?.(); }
    catch (error) {
      const status = error instanceof AccessError ? error.status : 503;
      throw new GraphQLError(error instanceof AccessError ? error.message : '身份服务暂时不可用', {
        extensions: { code: status === 401 ? 'LOGIN_REQUIRED' : 'ACCESS_DENIED', status },
      });
    }
    return routeData(resolveChoiceData, env, pathname, args);
  };
  const budget = resourceBudget();
  const resource = <Args extends Record<string, unknown>, Result>(
    field: string,
    action: (args: Args) => Result,
  ) => (args: Args): Result => budget.run(field, args, () => action(args));
  const rootValue = {
    chinamoneyShibor: resource("chinamoneyShibor", (args: Record<string, unknown>) => routeData(resolveChinamoneyData, env, "/chinamoney/shibor", args)),
    health: () => ({ status: "ok" }),
    config: () => ({ defaultDate: shanghaiToday() }),
    tradingDays: resource("tradingDays", (args: Record<string, unknown>) =>
      routeData(resolveTradingCalendarData, env, "/trading-days", args)),
    omo: resource("omo", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/omo", args)),
    cfets: resource("cfets", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/cfets", args)),
    cfetsHistories: resource("cfetsHistories", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/cfets-histories", args)),
    bondTopCase: resource("bondTopCase", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/bond-top-case", args)),
    futuresLatest: resource("futuresLatest", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/futures-latest", args)),
    primaryIssues: resource("primaryIssues", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/primary-issues", args)),
    brokerBondRegistrations: resource("brokerBondRegistrations", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/broker-bond-registrations", args)),
    todayTrades: resource("todayTrades", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/today-trades", args)),
    favoriteQuotes: resource("favoriteQuotes", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/favorite-quotes", args)),
    bondInfos: resource("bondInfos", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/bond-infos", args)),
    news: resource("news", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/news", args)),
    newsDetail: resource("newsDetail", (args: { articleId: string; fields?: string }) =>
      routeData(
        resolveDmData,
        env,
        `/news/${encodeURIComponent(args.articleId)}`,
        { fields: args.fields },
      )),
    wechatArticles: resource("wechatArticles", (args: Record<string, unknown>) =>
      routeData(resolveDmData, env, "/wechat-articles", args)),
    industry: resource("industry", (args: Record<string, unknown>) =>
      routeData(resolveEastmoneyData, env, "/industry", args)),
    stockSummary: resource("stockSummary", (args: Record<string, unknown>) =>
      routeData(resolveEastmoneyData, env, "/stock-summary", args)),
    margin: resource("margin", (args: Record<string, unknown>) =>
      routeData(resolveEastmoneyData, env, "/margin", args)),
    choiceCsd: resource("choiceCsd", (args: Record<string, unknown>) =>
      choiceData("/choice/csd", args)),
    choiceCss: resource("choiceCss", (args: Record<string, unknown>) =>
      choiceData("/choice/css", args)),
    choiceCtr: resource("choiceCtr", (args: Record<string, unknown>) =>
      choiceData("/choice/ctr", args)),
    choiceEdb: resource("choiceEdb", (args: Record<string, unknown>) =>
      choiceData("/choice/edb", args)),
    choiceDataStatistics: resource("choiceDataStatistics", (args: Record<string, unknown>) =>
      choiceData("/choice/data-statistics", args)),
  };

  const result = await graphql({
    schema: getSchema(),
    source: body.query,
    rootValue,
    variableValues: isRecord(body.variables) ? body.variables : undefined,
    operationName:
      typeof body.operationName === "string" ? body.operationName : undefined,
  });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
