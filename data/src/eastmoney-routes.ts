import { fetchMarginHistory, fetchStockMarketArticle } from "./eastmoney";
import {
  industrySnapshotSchema,
  marginBalanceSchema,
  parseObject,
  parseRows,
  projectObject,
  projectRows,
  stockSummarySchema,
} from "./contracts";
import { jsonResponse, optionalDate, requireMethod, shanghaiToday } from "./http";
import { collectMarketSnapshot } from "./services/eastmoney-market";

export async function resolveEastmoneyData(
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
) {
  const parameters = new URL(request.url).searchParams;
  if (pathname === "/industry") {
    requireMethod(request, "GET");
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const snapshot = parseObject(industrySnapshotSchema, await collectMarketSnapshot(env, date), "市场指数快照");
    return projectObject(industrySnapshotSchema, snapshot, parameters.get("fields"));
  }
  if (pathname === "/stock-summary") {
    requireMethod(request, "GET");
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const article = await fetchStockMarketArticle(date, env, 2);
    const summary = parseObject(stockSummarySchema, {
      title: article.title,
      time: article.time,
      paragraphs: article.summary_paragraphs,
      summary: article.summary_paragraphs.join("").trim(),
    }, "东方财富A股收评");
    return projectObject(stockSummarySchema, summary, parameters.get("fields"));
  }
  if (pathname === "/margin") {
    requireMethod(request, "GET");
    const date = optionalDate(parameters, "date") ?? shanghaiToday();
    const rows = parseRows(
      marginBalanceSchema,
      await fetchMarginHistory(date, env),
      "东方财富两融",
    );
    return projectRows(marginBalanceSchema, rows, parameters.get("fields"));
  }
  return null;
}

export async function handleEastmoneyRoute(
  request: Request,
  env: Cloudflare.Env,
  pathname: string,
): Promise<Response | null> {
  const data = await resolveEastmoneyData(request, env, pathname);
  return data === null ? null : jsonResponse(data);
}
