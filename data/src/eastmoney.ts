import { z } from "zod";

import { ApiError } from "./http";
import { requireUpstreamCapacity } from "./upstream-rate-limit";

const EASTMONEY_MARKET_LIST_API =
  "https://np-listapi.eastmoney.com/comm/web/getNewsByColumns";
const jsonRowSchema = z.record(z.string(), z.unknown());
const marginPayloadSchema = z.object({
  success: z.boolean().optional(),
  result: z.object({ data: z.array(jsonRowSchema.nullable()).nullish() }).nullish(),
});
const stockListPayloadSchema = z.object({
  data: z.object({ list: z.array(jsonRowSchema.nullable()).nullish() }).nullish(),
});

interface StockLink {
  title: string;
  time: string | null;
  timeText: string;
  url: string;
}

export interface StockArticle {
  title: string;
  time: string | null;
  url: string;
  paragraphs: string[];
  summary_paragraphs: string[];
  content: string;
}

export async function fetchMarginHistory(
  targetDate: string,
  env: Pick<Cloudflare.Env, "EASTMONEY_LIMIT">,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  url.search = new URLSearchParams({
    callback: "datatable7905705",
    reportName: "RPTA_RZRQ_LSDB",
    columns: "DIM_DATE,TOTAL_RZRQYE,TOTAL_RZYE,TOTAL_RQYE",
    source: "WEB",
    sortColumns: "DIM_DATE",
    sortTypes: "-1",
    pageNumber: "1",
    pageSize: "10",
    filter: `(DIM_DATE<='${targetDate}')`,
  }).toString();
  await requireUpstreamCapacity(env.EASTMONEY_LIMIT, "eastmoney", "东方财富网页");
  const response = await fetch(url, {
    headers: { Referer: "https://data.eastmoney.com/rzrq/" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ApiError(503, `东方财富两融请求失败 (HTTP ${response.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      source: "东方财富两融",
      stage: "fetch",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  const text = (await response.text())
    .trim()
    .replace(/^[^(]+\(/, "")
    .replace(/\);?$/, "");
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(text);
  } catch {
    throw new ApiError(503, "东方财富两融返回无效 JSONP", {
      code: "UPSTREAM_INVALID_JSON",
      source: "东方财富两融",
      stage: "response_parsing",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  const payload = marginPayloadSchema.safeParse(rawPayload);
  if (!payload.success || payload.data.success === false) {
    throw new ApiError(503, "东方财富两融返回格式无效", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      source: "东方财富两融",
      stage: "response_validation",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  return (payload.data.result?.data ?? [])
    .filter((row): row is Record<string, unknown> => row !== null)
    .slice(0, 2);
}

export function stockCloseTitleScore(title: string): number {
  let score = 0;
  if (title.includes("A股")) score += 3;
  if (title.includes("指数")) score += 3;
  if (["收涨", "收跌", "收盘", "收评"].some((keyword) => title.includes(keyword))) score += 2;
  if (title.includes("成交额")) score += 1;
  return score;
}

function isStockCloseLink(link: StockLink): boolean {
  if (["收评", "收盘", "收涨", "收跌"].some((keyword) => link.title.includes(keyword))) {
    return true;
  }
  return link.timeText.endsWith("15:00") &&
    ["A股", "沪指", "深证", "创业板", "指数"].some((keyword) => link.title.includes(keyword));
}

function pickStockMarketLink(links: StockLink[], targetDate: string): StockLink | undefined {
  return links
    .filter((link) => link.time?.slice(0, 10) === targetDate && isStockCloseLink(link))
    .sort((left, right) => {
      const score = stockCloseTitleScore(right.title) - stockCloseTitleScore(left.title);
      return score || String(right.time).localeCompare(String(left.time));
    })[0];
}

async function fetchStockMarketLinks(targetDate: string, env: Pick<Cloudflare.Env, "EASTMONEY_LIMIT">): Promise<StockLink[]> {
  const url = new URL(EASTMONEY_MARKET_LIST_API);
  for (const [name, value] of Object.entries({
    client: "web",
    biz: "web_news_col",
    column: "407",
    order: "1",
    needInteractData: "0",
    page_index: "1",
    page_size: "50",
    req_trace: String(Date.now()),
    fields: "code,showTime,title,mediaName,summary,image,url,uniqueUrl,Np_dst",
    types: "1,20",
  })) url.searchParams.set(name, value);
  await requireUpstreamCapacity(env.EASTMONEY_LIMIT, "eastmoney", "东方财富网页");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new ApiError(503, `东方财富大盘分析列表请求失败 (HTTP ${response.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      source: "东方财富大盘分析",
      stage: "fetch",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    throw new ApiError(503, "东方财富大盘分析列表不是有效 JSON", {
      code: "UPSTREAM_INVALID_JSON",
      source: "东方财富大盘分析",
      stage: "response_parsing",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  const body = stockListPayloadSchema.safeParse(rawBody);
  if (!body.success) {
    throw new ApiError(503, "东方财富大盘分析列表格式无效", {
      code: "UPSTREAM_SCHEMA_MISMATCH",
      source: "东方财富大盘分析",
      stage: "response_validation",
      upstreamStatus: response.status,
      upstreamPath: url.pathname,
    });
  }
  const rows = body.data.data?.list ?? [];
  const links: StockLink[] = [];
  for (const row of rows) {
    if (row === null) continue;
    if (typeof row.title !== "string" || typeof row.showTime !== "string") continue;
    const timeMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(row.showTime);
    if (!timeMatch?.[1] || !timeMatch[2]) continue;
    const code = typeof row.code === "string" ? row.code : "";
    const rawUrl = typeof row.uniqueUrl === "string" && row.uniqueUrl
      ? row.uniqueUrl
      : code ? `https://finance.eastmoney.com/a/${code}.html` : "";
    if (!rawUrl) continue;
    let articleUrl: URL;
    try {
      articleUrl = new URL(rawUrl);
    } catch {
      continue;
    }
    if (
      articleUrl.hostname !== "eastmoney.com" &&
      !articleUrl.hostname.endsWith(".eastmoney.com")
    ) continue;
    articleUrl.protocol = "https:";
    const [, date, hours] = timeMatch;
    links.push({
      title: row.title.trim(),
      time: `${date}T${hours}:00+08:00`,
      timeText: `${date.slice(5, 7)}月${date.slice(8, 10)}日 ${hours}`,
      url: articleUrl.toString(),
    });
  }
  return links.filter((link) => link.time?.startsWith(targetDate));
}

function htmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

export function articleParagraphsFromHtml(
  html: string,
  maximumParagraphs = Number.POSITIVE_INFINITY,
): string[] {
  const paragraphs: string[] = [];
  const id = /\bid=["']ContentBody["']/i.exec(html);
  if (id?.index === undefined) return paragraphs;
  const openingEnd = html.indexOf(">", id.index);
  if (openingEnd < 0) return paragraphs;
  const endings = [
    html.indexOf("<!-- 正文中部", openingEnd),
    html.indexOf('<div class="ad_context3"', openingEnd),
    html.indexOf("</div>", openingEnd),
  ].filter((value) => value >= 0);
  const ending = endings.length > 0 ? Math.min(...endings) : html.length;
  const content = html.slice(openingEnd + 1, ending);
  const children = /<(p|center|h[1-6]|blockquote|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of content.matchAll(children)) {
    const value = htmlText(match[2] ?? "");
    if (value) paragraphs.push(value);
    if (paragraphs.length >= maximumParagraphs) break;
  }
  return paragraphs;
}

async function articleParagraphs(
  response: Response,
  maximumParagraphs: number,
): Promise<string[]> {
  if (!Number.isFinite(maximumParagraphs)) {
    return articleParagraphsFromHtml(await response.text());
  }
  const paragraphs: string[] = [];
  let current: string | undefined;
  const rewritten = new HTMLRewriter()
    .on("#ContentBody > *", {
      element(element) {
        current = "";
        element.onEndTag(() => {
          const value = current?.replace(/\s+/g, " ").trim();
          if (value) paragraphs.push(value);
          current = undefined;
        });
      },
      text(text) {
        if (current !== undefined) current += text.text;
      },
    })
    .transform(response);
  const reader = rewritten.body?.getReader();
  if (!reader) return paragraphs;
  while (paragraphs.length < maximumParagraphs) {
    const { done } = await reader.read();
    if (done) break;
  }
  await reader.cancel();
  return paragraphs.slice(0, maximumParagraphs);
}

export async function fetchStockMarketArticle(
  targetDate: string,
  env: Pick<Cloudflare.Env, "EASTMONEY_LIMIT">,
  maximumParagraphs = Number.POSITIVE_INFINITY,
): Promise<StockArticle> {
  const link = pickStockMarketLink(
    await fetchStockMarketLinks(targetDate, env),
    targetDate,
  );
  if (!link) {
    throw new ApiError(404, `东方财富尚未发布 ${targetDate} A股收评`, {
      code: "RESOURCE_NOT_AVAILABLE",
      source: "东方财富大盘分析",
      stage: "article_discovery",
    });
  }

  await requireUpstreamCapacity(env.EASTMONEY_LIMIT, "eastmoney", "东方财富网页");
  const articleResponse = await fetch(link.url, { signal: AbortSignal.timeout(10_000) });
  if (!articleResponse.ok) {
    throw new ApiError(503, `东方财富 A股收评请求失败 (HTTP ${articleResponse.status})`, {
      code: "UPSTREAM_HTTP_ERROR",
      source: "东方财富大盘分析",
      stage: "article_fetch",
      upstreamStatus: articleResponse.status,
      upstreamPath: new URL(link.url).pathname,
    });
  }
  const paragraphs = await articleParagraphs(articleResponse, maximumParagraphs);
  if (paragraphs.length === 0) {
    throw new ApiError(503, `东方财富 ${targetDate} A股收评正文缺失`, {
      code: "UPSTREAM_CONTENT_MISSING",
      source: "东方财富大盘分析",
      stage: "article_parsing",
      upstreamStatus: articleResponse.status,
      upstreamPath: new URL(link.url).pathname,
    });
  }
  return {
    title: link.title,
    time: link.time,
    url: link.url,
    paragraphs,
    summary_paragraphs: paragraphs.slice(0, 2),
    content: paragraphs.join("\n").trim(),
  };
}
