import { readSse } from "../sse.ts";
import { sanitizeReasoningSummary } from "./ai-summary.ts";
export { readSse } from "../sse.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

/** Forward final text and explicitly requested public summaries only; never raw reasoning. */
export async function readResponsesStream(
  body: ReadableStream<Uint8Array>, onText: (delta: string) => void, maxBytes: number,
  onSummary?: (summary: { id: string; text: string }) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  let completed: unknown;
  const summaries = new Map<string, string>();
  const publishedSummaries = new Map<string, string>();
  function summary(id: string, text: string) {
    if (!text) return;
    summaries.set(id, text);
    const sanitized = sanitizeReasoningSummary(text);
    if (!sanitized || publishedSummaries.get(id) === sanitized) return;
    publishedSummaries.set(id, sanitized);
    onSummary?.({ id, text: sanitized });
  }
  function itemSummaries(item: Record<string, unknown>, index: number) {
    if (item.type !== "reasoning" || !Array.isArray(item.summary)) return;
    item.summary.forEach((part, partIndex) => {
      if (object(part) && part.type === "summary_text" && typeof part.text === "string")
        summary(`${index}:${partIndex}`, part.text);
    });
  }
  const phases = new Map<number, string>();
  await readSse(body, ({ data }) => {
    if (data === "[DONE]") return;
    const value: unknown = JSON.parse(data);
    if (!object(value)) return;
    const index = typeof value.output_index === "number" ? value.output_index : 0;
    if (value.type === "response.output_item.added" && object(value.item)) {
      phases.set(index, typeof value.item.phase === "string" ? value.item.phase : "");
    }
    const summaryId = `${index}:${typeof value.summary_index === "number" ? value.summary_index : 0}`;
    if (value.type === "response.reasoning_summary_text.delta" && typeof value.delta === "string")
      summary(summaryId, (summaries.get(summaryId) ?? "") + value.delta);
    if (value.type === "response.reasoning_summary_text.done" && typeof value.text === "string")
      summary(summaryId, value.text);
    if (value.type === "response.reasoning_summary_part.done" && object(value.part)
      && value.part.type === "summary_text" && typeof value.part.text === "string") summary(summaryId, value.part.text);
    if (value.type === "response.output_item.done" && object(value.item)) itemSummaries(value.item, index);
    if (value.type === "response.completed" && object(value.response) && Array.isArray(value.response.output))
      value.response.output.forEach((item, i) => { if (object(item)) itemSummaries(item, i); });
    if (value.type === "response.output_text.delta" && typeof value.delta === "string"
      && phases.get(index) !== "commentary") onText(value.delta);
    if (["response.completed", "response.failed", "response.incomplete"].includes(String(value.type))) {
      if (!object(value.response)) throw new Error("AI stream terminal event has no response");
      completed = value.response;
    }
    if (value.type === "error") throw new Error("AI stream reported an error");
  }, maxBytes, { signal, shouldStop: () => completed !== undefined });
  if (!completed) throw new Error("AI stream ended before response completion");
  return completed;
}
