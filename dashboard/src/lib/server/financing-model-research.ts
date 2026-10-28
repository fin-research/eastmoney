import type { IssuanceSnapshot } from "../issuance-model";
import { z } from "zod";

import {
  sellSidePayloadSchema,
  type FinancingModelSnapshot,
  type SellSidePayload,
} from "../financing-model.ts";
import {
  AI_GATEWAY_MODEL,
  generateAiGatewayObject,
  type AiGatewayCredentials,
} from "./ai-gateway.ts";

const AI_SEARCH_MCP_URL = "https://research.hasbai.xyz/mcp";
const AI_SEARCH_MAX_RESULTS = 50 as const;
const MAX_MCP_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_SOURCE_DOCUMENTS = 24;
const MAX_DOCUMENT_TEXT = 2_400;
const PROMPT_CACHE_KEY = "financing-model-sell-side:v7";

const researchOutputSchema = z
  .object({
    logicSummary: z.string().min(1).max(1600),
    views: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(20),
            summary: z.string().min(1).max(1200),
            implication: z.string().min(1).max(800),
          })
          .strict(),
      )
      .min(4)
      .max(5),
  })
  .strict();

type ResearchOutput = z.infer<typeof researchOutputSchema>;

export interface ResearchDocument {
  sourceId: string;
  institution: string;
  title: string;
  publishedAt: string;
  sourceKey: string;
  text: string;
}

interface AiSearchChunk {
  text?: unknown;
  item?: {
    key?: unknown;
    metadata?: {
      source?: unknown;
      published_at?: unknown;
    };
  };
}

export class FinancingModelResearchError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FinancingModelResearchError";
    this.status = status;
  }
}

export async function generateFinancingModelResearch(
  snapshot: FinancingModelSnapshot | IssuanceSnapshot,
  credentials: AiGatewayCredentials,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal; onProgress?: (summary: string) => void } = {},
): Promise<SellSidePayload> {
  options.signal?.throwIfAborted();
  const period = aiSearchPeriod(snapshot.as_of_date);
  const searchQuery = buildResearchQuery(snapshot);
  const response = await fetcher(AI_SEARCH_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(buildAiSearchToolCall(searchQuery, period)),
    signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]),
  });
  const responseText = await readTextBounded(response, MAX_MCP_RESPONSE_BYTES);
  if (!response.ok) {
    throw new FinancingModelResearchError(
      502,
      `AI Search 检索失败（HTTP ${response.status}）`,
    );
  }
  const documents = parseAiSearchResponse(responseText).slice(
    0,
    MAX_SOURCE_DOCUMENTS,
  );
  if (new Set(documents.map((document) => document.institution)).size < 4) {
    throw new FinancingModelResearchError(
      422,
      "最近七日 AI Search 结果不足四家直接相关卖方机构",
    );
  }

  const analysis = await generateAiGatewayObject(
    credentials,
    researchMessages(snapshot, documents),
    researchOutputSchema,
    "financing_model_sell_side",
    {
      signal: options.signal,
      ...(options.onProgress ? {
        onReasoningSummary: (summary: { id: string; text: string }) => options.onProgress?.(summary.text),
      } : {}),
      promptCacheKey: PROMPT_CACHE_KEY,
      metadata: {
        tags: "financing-model,sell-side,ai-search",
        run_id: snapshot.run_id,
        period_start: period.startDate,
        period_end: period.endDate,
      },
      requestTimeoutMs: 300_000,
      taskType: "analysis",
    },
  );
  const views = resolveResearchViews(analysis, documents);
  return sellSidePayloadSchema.parse({
    generatedAt: new Date().toISOString(),
    periodStart: period.startDate,
    periodEnd: period.endDate,
    searchQuery,
    maxResults: AI_SEARCH_MAX_RESULTS,
    sourceDocuments: documents.length,
    modelName: AI_GATEWAY_MODEL,
    logicSummary: analysis.logicSummary,
    edited: false,
    updatedAt: null,
    views,
  });
}

export function aiSearchPeriod(asOfDate: string): {
  startDate: string;
  endDate: string;
  startMs: number;
  endMs: number;
} {
  const end = new Date(`${asOfDate}T00:00:00Z`);
  if (Number.isNaN(end.valueOf()) || end.toISOString().slice(0, 10) !== asOfDate) {
    throw new FinancingModelResearchError(400, "模型日期无效");
  }
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  const startDate = start.toISOString().slice(0, 10);
  return {
    startDate,
    endDate: asOfDate,
    startMs: Date.parse(`${startDate}T00:00:00+08:00`),
    endMs: Date.parse(`${asOfDate}T23:59:59.999+08:00`),
  };
}

export function buildAiSearchToolCall(
  query: string,
  period: ReturnType<typeof aiSearchPeriod>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: {
      name: "search",
      arguments: {
        query,
        ai_search_options: {
          retrieval: {
            max_num_results: AI_SEARCH_MAX_RESULTS,
            filters: {
              type: { $eq: "研报" },
              published_at: {
                $gte: period.startMs,
                $lte: period.endMs,
              },
            },
          },
        },
      },
    },
  };
}

export function parseAiSearchResponse(text: string, maxDocumentText = MAX_DOCUMENT_TEXT): ResearchDocument[] {
  const envelope = parseMcpEnvelope(text);
  const content = envelope.result?.content;
  if (!Array.isArray(content)) {
    throw new FinancingModelResearchError(502, "AI Search MCP 响应缺少 content");
  }
  const chunks: AiSearchChunk[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (value.type !== "text" || typeof value.text !== "string") continue;
    try {
      const parsed = JSON.parse(value.text) as {
        result?: { chunks?: AiSearchChunk[] };
      };
      if (Array.isArray(parsed.result?.chunks)) chunks.push(...parsed.result.chunks);
    } catch {
      continue;
    }
  }
  return compactResearchDocuments(chunks, maxDocumentText);
}

function parseMcpEnvelope(text: string): {
  result?: { content?: unknown };
} {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new FinancingModelResearchError(502, "AI Search MCP 返回空响应");
  }
  const payloads = trimmed.startsWith("event:") || trimmed.startsWith("data:")
    ? trimmed
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
    : [trimmed];
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload) as {
        error?: { message?: string };
        result?: { content?: unknown };
      };
      if (parsed.error) {
        throw new FinancingModelResearchError(
          502,
          `AI Search MCP 错误: ${parsed.error.message ?? "未知错误"}`,
        );
      }
      if (parsed.result) return parsed;
    } catch (error) {
      if (error instanceof FinancingModelResearchError) throw error;
    }
  }
  throw new FinancingModelResearchError(502, "AI Search MCP 响应不是有效 JSON-RPC");
}

function compactResearchDocuments(chunks: AiSearchChunk[], maxDocumentText: number): ResearchDocument[] {
  const grouped = new Map<
    string,
    Omit<ResearchDocument, "sourceId"> & { textParts: string[] }
  >();
  for (const chunk of chunks) {
    const key = textValue(chunk.item?.key);
    const institution = textValue(chunk.item?.metadata?.source);
    const publishedAt = publishedDate(chunk.item?.metadata?.published_at);
    const body = textValue(chunk.text);
    if (!key || !institution || !publishedAt || !body) continue;
    const existing = grouped.get(key);
    if (existing) {
      if (existing.textParts.join("\n").length < maxDocumentText) {
        existing.textParts.push(body);
      }
      continue;
    }
    grouped.set(key, {
      institution,
      title: documentTitle(key, body),
      publishedAt,
      sourceKey: key,
      text: "",
      textParts: [body],
    });
  }
  return [...grouped.values()].map((document, index) => ({
    sourceId: `S${index + 1}`,
    institution: document.institution,
    title: document.title,
    publishedAt: document.publishedAt,
    sourceKey: document.sourceKey,
    text: [...new Set(document.textParts)].join("\n").slice(0, maxDocumentText),
  }));
}

function resolveResearchViews(
  analysis: ResearchOutput,
  documents: ResearchDocument[],
): SellSidePayload["views"] {
  const documentById = new Map(documents.map((document) => [document.sourceId, document]));
  const usedSources = new Set<string>();
  const usedInstitutions = new Set<string>();
  const views = [];
  for (const view of analysis.views) {
    const document = documentById.get(view.sourceId);
    if (
      !document ||
      usedSources.has(document.sourceId) ||
      usedInstitutions.has(document.institution)
    ) {
      continue;
    }
    usedSources.add(document.sourceId);
    usedInstitutions.add(document.institution);
    views.push({
      institution: document.institution,
      title: document.title,
      publishedAt: document.publishedAt,
      stance: "mixed" as const,
      summary: view.summary,
      implication: view.implication,
      sourceKey: document.sourceKey,
    });
  }
  if (views.length < 4) {
    throw new FinancingModelResearchError(
      502,
      "模型未返回四家可核验且互不重复的卖方机构观点",
    );
  }
  return views.slice(0, 5);
}

function researchMessages(
  snapshot: FinancingModelSnapshot | IssuanceSnapshot,
  documents: ResearchDocument[],
) {
  return [
    {
      role: "system" as const,
      content:
        "你是债券融资择时研究员。只能使用提供的 AI Search 证据，筛选4至5家直接讨论资金面、利率债、信用利差或一级发行环境的机构。" +
        "不得补充外部知识，不得把量化、转债或权益主题凑数。logicSummary 必须把卖方共识、分歧及其影响融资成本的传导逻辑整合成一个连贯自然段，" +
        "不得使用项目符号、小标题、交叉验证或支持模型等表述。views 必须保留4至5家机构各自的核心判断和对发行的含义，" +
        "每条 summary 的第一个字必须直接进入市场判断，只写观点正文；必须完全删除‘机构在《研报标题》（发布日期）指出/认为/表示’一类来源引导句，" +
        "不得重复机构名、研报标题、发布日期、来源或使用引导性小标题；implication 只写对发行成本与时点的含义。" +
        "每条观点只引用一个 sourceId；不得改写机构、标题、日期或 sourceId。",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        model: "forecast" in snapshot ? {
          asOfDate:snapshot.as_of_date,marketDataDate:snapshot.market_source_date,
          couponPercent:snapshot.forecast[0]?.coupon_percent, decision:snapshot.decision,
          shap:snapshot.explanation, futureWindow:snapshot.forecast,
        } : {
          asOfDate: snapshot.as_of_date,
          marketDataDate: snapshot.market_data_date,
          deviationBp: snapshot.prediction.deviation_bp,
          historicalPercentile: snapshot.prediction.historical_percentile,
          recommendation: snapshot.prediction.recommendation,
          decision: snapshot.prediction.decision,
          drivers: snapshot.market_drivers.map((driver) => ({
            name: driver.display_name,
            impact: driver.impact,
            value: driver.value,
          })),
        },
        evidence: documents,
      }),
    },
  ];
}

function buildResearchQuery(snapshot: FinancingModelSnapshot | IssuanceSnapshot): string {
  const driverNames = ("forecast" in snapshot ? [] : snapshot.market_drivers)
    .slice(0, 5)
    .map((driver) => driver.display_name)
    .join("、");
  return (
    "债券市场卖方固收研报 资金面 流动性 利率债 信用利差 政府债供给 " +
    `一级发行 发行成本 ${driverNames}`
  );
}

function documentTitle(key: string, body: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 300);
  const fileName = key.split("/").at(-1) ?? key;
  return fileName.replace(/\.md$/i, "").slice(0, 300);
}

function publishedDate(value: unknown): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(milliseconds));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new FinancingModelResearchError(502, "AI Search MCP 响应过大");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new FinancingModelResearchError(502, "AI Search MCP 响应过大");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
