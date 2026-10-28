import { sanitizeReasoningSummary } from "./ai-summary.ts";

export const AI_SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
} as const;

export type AiSseEvent = "progress" | "result" | "error";

/** SSE owns event type; progress/error data stays plain text and result data is the complete JSON value. */
export function encodeAiSse(event: AiSseEvent, value: unknown): Uint8Array {
  const data = event === "result" ? JSON.stringify(value) : String(value);
  const fields = data
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return new TextEncoder().encode(`event: ${event}\n${fields}\n\n`);
}

interface AiSseContext {
  signal: AbortSignal;
  progress: (summary: string) => void;
}

interface AiSseResponseOptions {
  errorMessage: (error: unknown) => string;
  onError?: (error: unknown) => void;
}

export function createAiSseResponse<T>(
  request: Request,
  run: (context: AiSseContext) => Promise<T>,
  options: AiSseResponseOptions,
): Response {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AiSseEvent, value: unknown) => {
        if (closed || signal.aborted) return;
        if ((controller.desiredSize ?? 0) < -16) {
          cancelled.abort(new DOMException("Slow SSE consumer", "AbortError"));
          return;
        }
        controller.enqueue(encodeAiSse(event, value));
      };
      const heartbeat = setInterval(() => {
        if (closed || signal.aborted) return;
        if ((controller.desiredSize ?? 0) < -16) {
          cancelled.abort(new DOMException("Slow SSE consumer", "AbortError"));
          return;
        }
        controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
      }, 15_000);
      let previousSummary = "";
      try {
        const result = await run({
          signal,
          progress(summary) {
            const next = sanitizeReasoningSummary(summary);
            if (!next || next === previousSummary) return;
            previousSummary = next;
            send("progress", next);
          },
        });
        send("result", result);
      } catch (error) {
        if (!signal.aborted) {
          options.onError?.(error);
          send("error", options.errorMessage(error));
        }
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      cancelled.abort();
    },
  });
  return new Response(body, { headers: AI_SSE_HEADERS });
}
