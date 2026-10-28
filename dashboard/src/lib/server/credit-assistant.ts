import { z } from "zod";
import { generateAiGatewayObject, type AiGatewayCredentials } from "./ai-gateway.ts";
import type { CreditAnswer, CreditTurn } from "../credit-assistant/types.ts";
import { CreditTrace } from "./credit-tracing.ts";

export type CreditSearchHit = { id?: string; key: string; text: string };
export type CreditSearch = (question: string) => Promise<CreditSearchHit[]>;

const queuedAnswerSchema = z.object({ id: z.string().uuid(), question: z.string().min(1) });
export async function recoverQueuedCreditAnswers(
  jobs: Array<{ id: string; callback: string; payload: unknown }>,
  schedule: (payload: z.infer<typeof queuedAnswerSchema>) => Promise<unknown>,
  dequeue: (id: string) => void,
): Promise<void> {
  for (const job of jobs) {
    const payload = queuedAnswerSchema.safeParse(job.payload);
    if (job.callback !== "answerQuestion" || !payload.success) continue;
    await schedule(payload.data);
    dequeue(job.id);
  }
}

const responseSchema = z.object({
  paragraphs: z.array(z.object({ text: z.string().min(1).max(2000), sourceIds: z.array(z.string()).max(8) })).max(8),
  gaps: z.array(z.string().max(500)).max(8),
  attachmentSourceIds: z.array(z.string()).max(12),
});

const PROMPT = `你是东方财富证券授信资料助手。直接根据本轮 AI Search 返回的检索片段回答用户问题，并结合最近对话理解追问。
只使用提供的检索片段，不根据文件名或常识补造数值。注意报告期、母公司/合并口径与单位；片段不能确定答案时，在 gaps 中直接说明缺少什么。不要把其他年度或其他口径的数值代替所问数值。扫描页 OCR 可能误识别数字，不凭异常字符推断财务数值；年度 ROE 优先核对审计报告补充资料表格的指标名、行名和数值。
用 paragraphs 给出简洁答复，每段的 sourceIds 只填确实支持该段的片段 ID；如用户索取原件，在 attachmentSourceIds 中填对应片段 ID。没有支持片段时 paragraphs 留空。只返回指定结构。`;

function fileUrl(key: string): string | undefined {
  const match = /^credit\/public\/([^/]+\.pdf)$/i.exec(key);
  const filename = match?.[1];
  return filename && !/[\\\u0000-\u001f\u007f]/.test(filename)
    ? `/api/credit-assistant/files/${encodeURIComponent(filename)}` : undefined;
}

export async function answerCreditQuestion(options: {
  question: string;
  history: CreditTurn[];
  credentials: AiGatewayCredentials;
  semanticSearch: CreditSearch;
  generate?: typeof generateAiGatewayObject;
  progress?: (message: string) => void;
  summary?: (text: string) => void;
  modelStarted?: () => void;
  trace?: CreditTrace;
  runId?: string;
}): Promise<CreditAnswer> {
  const trace = options.trace ?? new CreditTrace();
  options.progress?.("正在检索资料");
  const hits = await trace.tool("ai_search", {}, () => options.semanticSearch(options.question));
  const sources = hits.filter(hit => hit.text.trim()).map((hit, index) => ({
    id: `search-${index + 1}`, documentId: hit.key, title: hit.key.split("/").at(-1) || hit.key,
    locator: "AI Search 检索片段", extraction: "ai_search" as const,
    text: hit.text, url: fileUrl(hit.key),
  }));
  if (!sources.length) {
    return { status: "insufficient", paragraphs: [], gaps: ["当前公开资料未检索到相关内容。"],
      sources: [], files: [], createdAt: new Date().toISOString() };
  }

  options.progress?.("正在整理答复");
  options.modelStarted?.();
  const response = responseSchema.parse(await trace.chat({ "credit.stage": "decision", "credit.source_count": sources.length }, span =>
    (options.generate ?? generateAiGatewayObject)(options.credentials, [
      { role: "system", content: PROMPT },
      { role: "user", content: JSON.stringify({ question: options.question,
        history: options.history.slice(-6).map(turn => ({ question: turn.question,
          answer: turn.answer.paragraphs.map(paragraph => paragraph.text) })),
        sources: sources.map(({ id, title, text }) => ({ id, title, text })) }) },
    ], responseSchema, "credit_answer", {
      taskType: "credit_answer", promptCacheKey: "credit-direct-rag:v1", requestTimeoutMs: 300_000,
      metadata: { business: "credit-assistant", prompt_version: "direct-rag-v1", ...(options.runId ? { credit_run_id: options.runId } : {}) },
      onReasoningSummary: summary => options.summary?.(summary.text),
      onTelemetry: metadata => span.modelResponse(metadata),
    })));

  const byId = new Map(sources.map(source => [source.id, source]));
  const paragraphs = response.paragraphs.map(paragraph => ({ text: paragraph.text,
    citations: [...new Set(paragraph.sourceIds)].filter(id => byId.has(id)).map(sourceId => ({
      sourceId, quote: byId.get(sourceId)!.text.slice(0, 500),
    })) }));
  const referencedIds = new Set([...paragraphs.flatMap(paragraph => paragraph.citations.map(citation => citation.sourceId)),
    ...response.attachmentSourceIds.filter(id => byId.has(id))]);
  const cited = sources.filter(source => referencedIds.has(source.id));
  const files = [...new Map(cited.filter(source => source.url).map(source => [source.documentId,
    { id: source.documentId, title: source.title, url: source.url! }])).values()];
  const gaps = response.gaps.length ? response.gaps : paragraphs.length || files.length ? [] : ["当前检索片段不足以回答该问题。"];
  return { status: paragraphs.length || files.length ? gaps.length ? "partial" : "complete" : "insufficient",
    paragraphs, gaps, sources: cited.map(({ text: _text, ...source }) => source),
    files, createdAt: new Date().toISOString() };
}
