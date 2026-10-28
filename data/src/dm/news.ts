import { z } from "zod";
import { ApiError } from "../http";
import { newsSummarySchema, newsDetailSchema, parseObject, parseRows } from "../contracts";
import {
  DEFAULT_NEWS_TAB_ICON_IDS,
  fetchNewsDetail,
  fetchNewsList,
} from "./client";

type DmEnv = Pick<Cloudflare.Env, "DM" | "DM_COOKIE" | "DM_LIMIT">;
type Row = Record<string, unknown>;
type NewsSummary = z.infer<typeof newsSummarySchema>;
const newsSummariesPageSchema = z.object({ list: z.array(newsSummarySchema) });

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRow);
}

function objectValue(value: unknown): Row {
  return isRow(value) ? value : {};
}

function newsKey(row: Row): string {
  return `${String(row.sentimentId ?? "")}\u0000${String(row.newsId ?? "")}`;
}

function issueTime(row: Row): number | null {
  if (typeof row.time !== "string") return null;
  const value = Date.parse(row.time);
  return Number.isNaN(value) ? null : value;
}

export async function fetchNewsSummaries(
  env: DmEnv,
  options: {
    pageSize: number;
    tag?: string;
    important?: boolean;
    startTime?: number;
    endTime?: number;
    maximumPages?: number;
    requireComplete?: boolean;
  },
): Promise<Row & { list: NewsSummary[] }> {
  const shouldPaginate = options.startTime !== undefined || options.endTime !== undefined;
  const upstreamPageSize = shouldPaginate ? 100 : options.pageSize;
  let endPageId: string | undefined;
  let firstPage: Row | undefined;
  let lastPage: Row | undefined;
  const items: Row[] = [];
  const seen = new Set<string>();
  let reachedOlderNews = false;

  for (let pageIndex = 0; pageIndex < (shouldPaginate ? options.maximumPages ?? 20 : 1); pageIndex += 1) {
    const page = await fetchNewsList(env, {
      pageSize: upstreamPageSize,
      importanceStatus: options.important === true ? 1 : 0,
      endPageId,
    });
    firstPage ??= page;
    lastPage = page;
    const rows = objectRows(page.list);
    if (rows.length === 0) break;

    for (const row of rows) {
      const time = issueTime(row);
      if (options.requireComplete && time === null) {
        // An unreadable timestamp cannot prove that this page is outside the
        // requested date range. Other DTO fields matter only for selected rows.
        parseObject(newsSummarySchema, row, "DM新闻正文批次摘要");
      }
      if (options.startTime !== undefined) {
        if (time === null) continue;
        if (time < options.startTime) {
          reachedOlderNews = true;
          continue;
        }
      }
      if (options.endTime !== undefined && (time === null || time > options.endTime)) continue;
      if (options.tag !== undefined &&
          !(Array.isArray(row.tags) && row.tags.includes(options.tag))) continue;
      if (options.important !== undefined && row.important !== options.important) continue;
      const key = newsKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(row);
    }

    const nextPageId = typeof page.endPageId === "string" ? page.endPageId : undefined;
    if (
      items.length >= options.pageSize ||
      reachedOlderNews ||
      !page.hasNextPage ||
      !nextPageId ||
      nextPageId === endPageId
    ) {
      break;
    }
    endPageId = nextPageId;
  }

  if (options.requireComplete && items.length < options.pageSize && !reachedOlderNews && lastPage?.hasNextPage) {
    throw new ApiError(503, "新闻列表扫描未完成，不能返回不完整批次");
  }
  const selected = items.slice(0, options.pageSize);
  // Validate selected rows once; unrelated dates need only a readable timestamp.
  // Summary mode retains its existing missing-row normalization.
  const list = options.requireComplete
    ? parseObject(newsSummariesPageSchema, { list: selected }, "DM新闻正文批次摘要").list
    : parseRows(newsSummarySchema, selected, "DM新闻列表");
  const result: Row & { list: NewsSummary[] } = { ...(firstPage ?? {}), pageSize: options.pageSize, list };
  if (lastPage) {
    result.endPageId = lastPage.endPageId;
    result.hasNextPage = Boolean(lastPage.hasNextPage && !reachedOlderNews);
  }
  return result;
}

/** Fetch bodies only for the requested page; a batch failure fails the resource. */
export async function fetchNewsBatch(
  env: DmEnv,
  summaries: Row[],
): Promise<z.infer<typeof newsDetailSchema>[]> {
  const output: z.infer<typeof newsDetailSchema>[] = new Array(summaries.length);
  let next = 0;
  let failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(5, summaries.length) }, async () => {
    while (!failed && next < summaries.length) {
      const index = next++;
      const summary = summaries[index]!;
      try {
        const result = await fetchNewsDetail(env, { sentimentId: String(summary.sentimentId) });
        const detail = parseObject(newsDetailSchema, result.data, "DM新闻详情");
        if (detail.sentimentId !== summary.sentimentId) throw new ApiError(503, "新闻详情标识不匹配");
        output[index] = { ...summary, ...detail };
      } catch (error) { failed = true; throw error; }
    }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return output;
}

export async function fetchImportantNews(
  env: DmEnv,
  targetDate: string,
  pageSize = 50,
  maximumPages = 20,
  maximumSubrequests = 48,
): Promise<Row[]> {
  const items: Row[] = [];
  const seen = new Set<string>();
  let endPageId: string | undefined;
  let subrequests = 0;
  let exhausted = false;

  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    if (subrequests >= maximumSubrequests) break;
    const page = await fetchNewsList(env, {
      pageSize,
      importanceStatus: 1,
      tabIconIds: DEFAULT_NEWS_TAB_ICON_IDS,
      endPageId,
    });
    subrequests += 1;
    const rows = objectRows(page.list);
    if (rows.length === 0) break;
    let reachedOlderNews = false;
    for (const row of rows) {
      const date = typeof row.time === "string" ? row.time.slice(0, 10) : "";
      if (date < targetDate) {
        reachedOlderNews = true;
        continue;
      }
      if (date !== targetDate) continue;
      const key = newsKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      if (subrequests >= maximumSubrequests) {
        exhausted = true;
        break;
      }
      const detail = await fetchNewsDetail(env, {
        sentimentId: typeof row.sentimentId === "string" ? row.sentimentId : undefined,
        newsId: typeof row.newsId === "string" ? row.newsId : undefined,
      });
      subrequests += 1;
      const detailRow = objectValue(detail.data);
      items.push({
        ...row,
        ...Object.fromEntries(
          Object.entries(detailRow).filter(([, value]) =>
            value !== null && value !== undefined && value !== "" &&
            !(Array.isArray(value) && value.length === 0)),
        ),
      });
    }
    const nextPageId = typeof page.endPageId === "string" ? page.endPageId : undefined;
    if (exhausted || reachedOlderNews || !page.hasNextPage || !nextPageId || nextPageId === endPageId) break;
    endPageId = nextPageId;
  }
  return items.sort((left, right) => (issueTime(right) ?? 0) - (issueTime(left) ?? 0));
}

export function formatNewsItem(index: number, item: Row): string {
  const timeText = typeof item.time === "string" ? item.time.replace("T", " ").slice(0, 19) : "--";
  const tags = Array.isArray(item.tags) && item.tags.length > 0 ? item.tags.join("、") : "--";
  const content = typeof item.content === "string" && item.content ? item.content : "（无正文）";
  return [
    `【${index}】${timeText} ${String(item.title ?? "")}`,
    `标签：${tags}`,
    "正文：",
    content,
  ].join("\n");
}
