import { z } from "zod";
import { readResponsesStream } from "./ai-stream.ts";
import { AI_GATEWAY_MODEL } from "../agent-model.ts";
export { AI_GATEWAY_MODEL } from "../agent-model.ts";

const MAX_AI_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CREDIT_GATEWAY_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_AI_GATEWAY_TIMEOUT_MS = 300_000;

export const AI_GATEWAY_PROVIDER = "custom-codex" as const;
export function aiGatewayResponsesUrl(credentials: Pick<AiGatewayCredentials, "accountId" | "gatewayId">): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(credentials.accountId)}/` +
    `${encodeURIComponent(credentials.gatewayId)}/${encodeURIComponent(AI_GATEWAY_PROVIDER)}/responses`;
}
export const AI_GATEWAY_REASONING_EFFORT_BY_TASK = {
  generation: "xhigh",
  market_briefing: "xhigh",
  analysis: "xhigh",
  commentary: "xhigh",
  credit_answer: "xhigh",
  summary: "xhigh",
} as const;

export type AiGatewayTaskType = keyof typeof AI_GATEWAY_REASONING_EFFORT_BY_TASK;

export interface AiGatewayCredentials {
  accountId: string;
  gatewayId: string;
  token: string;
}

export interface AiGatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiGatewayTool {
  type: "web_search";
}

export interface AiGatewayOptions {
  metadata: Record<string, string | number | boolean>;
  promptCacheKey: string;
  requestTimeoutMs: number;
  taskType: AiGatewayTaskType;
  tools?: readonly AiGatewayTool[];
  /** Workflow callers delegate every retry to their durable step. */
  retry?: boolean;
  signal?: AbortSignal;
  onAttempt?: (attempt: "primary" | "retry") => void;
  onReasoningSummary?: (summary: { id: string; text: string }) => void;
  onTextDelta?: (delta: string) => void;
  onTelemetry?: (metadata: AiGatewayTelemetry) => void;
}

/** Optional, payload-free response metadata. Missing usage remains unknown, not zero. */
export interface AiGatewayTelemetry {
  status?: number;
  gatewayLogId: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

function notifyTelemetry(options: AiGatewayOptions, metadata: AiGatewayTelemetry) {
  try { options.onTelemetry?.(metadata); } catch { /* Tracing cannot change retries or business output. */ }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface AiGatewayAttemptFailure {
  provider: string;
  status: number | null;
  gatewayLogId: string;
  retryable: boolean;
  message: string;
}

export class AiGatewayResponseError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly gatewayLogId: string;
  readonly retryable: boolean;

  constructor(failure: AiGatewayAttemptFailure) {
    super(
      `AI Gateway provider ${failure.provider} failed` +
        (failure.status === null ? "" : ` with HTTP ${failure.status}`) +
        (failure.gatewayLogId ? ` (log ${failure.gatewayLogId})` : "") +
        (failure.message ? `: ${failure.message.slice(0, 1_000)}` : ""),
    );
    this.name = "AiGatewayResponseError";
    this.provider = failure.provider;
    this.status = failure.status;
    this.gatewayLogId = failure.gatewayLogId;
    this.retryable = failure.retryable;
  }

  toFailure(): AiGatewayAttemptFailure {
    return {
      provider: this.provider,
      status: this.status,
      gatewayLogId: this.gatewayLogId,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

export class AiGatewayRetryError extends Error {
  readonly failures: readonly AiGatewayAttemptFailure[];

  constructor(failures: readonly AiGatewayAttemptFailure[]) {
    super(
      "AI Gateway attempts failed: " +
        failures
          .map(
            (failure) =>
              failure.provider +
              (failure.status === null ? "" : ` HTTP ${failure.status}`) +
              (failure.gatewayLogId ? ` log ${failure.gatewayLogId}` : ""),
          )
          .join("; "),
    );
    this.name = "AiGatewayRetryError";
    this.failures = failures;
  }
}

const responseEnvelopeSchema = z
  .object({
    status: z.enum([
      "completed",
      "failed",
      "in_progress",
      "cancelled",
      "queued",
      "incomplete",
    ]),
    output: z.array(z.unknown()),
    error: z
      .object({
        code: z.string().nullable().optional(),
        message: z.string(),
      })
      .nullable()
      .optional(),
    incomplete_details: z
      .object({ reason: z.string().optional() })
      .nullable()
      .optional(),
    prompt_cache_key: z.string().nullable().optional(),
    usage: z
      .object({
        input_tokens_details: z
          .object({
            cached_tokens: z.number().int().nonnegative().optional(),
            cache_write_tokens: z.number().int().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export async function generateAiGatewayObject<OUTPUT>(
  credentials: AiGatewayCredentials,
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  schemaName: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch = fetch,
): Promise<OUTPUT> {
  options.signal?.throwIfAborted();
  const normalizedCredentials = validateCredentials(credentials);
  const normalizedSchemaName = requiredConfig("schema name", schemaName);
  const normalizedPromptCacheKey = requiredConfig(
    "prompt cache key",
    options.promptCacheKey,
  );
  validateRequestTimeout(options.requestTimeoutMs);
  const requestSchema = z.toJSONSchema(schema);
  delete requestSchema.$schema;

  const primary = await attemptProvider(
    normalizedCredentials,
    AI_GATEWAY_PROVIDER,
    "primary",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    normalizedPromptCacheKey,
    options,
    fetcher,
  );
  options.signal?.throwIfAborted();
  if (primary.ok) return primary.value;
  // Workflow steps and credit answers own their attempt budget.
  if (options.retry === false || options.taskType === "credit_answer") throw primary.error;
  if (!primary.error.retryable) throw primary.error;

  console.warn(
    JSON.stringify({
      event: "ai_gateway_retry_started",
      provider: primary.error.provider,
      status: primary.error.status,
      gateway_log_id: primary.error.gatewayLogId,
      error: primary.error.message,
    }),
  );

  const retry = await attemptProvider(
    normalizedCredentials,
    AI_GATEWAY_PROVIDER,
    "retry",
    messages,
    schema,
    requestSchema,
    normalizedSchemaName,
    normalizedPromptCacheKey,
    options,
    fetcher,
  );
  options.signal?.throwIfAborted();
  if (retry.ok) return retry.value;
  throw new AiGatewayRetryError([
    primary.error.toFailure(),
    retry.error.toFailure(),
  ]);
}

async function attemptProvider<OUTPUT>(
  credentials: AiGatewayCredentials,
  provider: string,
  attempt: "primary" | "retry",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  promptCacheKey: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch,
): Promise<
  | { ok: true; value: OUTPUT }
  | { ok: false; error: AiGatewayResponseError }
> {
  try {
    return {
      ok: true,
      value: await runProvider(
        credentials,
        provider,
        attempt,
        messages,
        schema,
        requestSchema,
        schemaName,
        promptCacheKey,
        options,
        fetcher,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AiGatewayResponseError
          ? error
          : new AiGatewayResponseError({
              provider,
              status: null,
              gatewayLogId: "",
              retryable: true,
              message: error instanceof Error ? error.message : String(error),
            }),
    };
  }
}

async function runProvider<OUTPUT>(
  credentials: AiGatewayCredentials,
  provider: string,
  attempt: "primary" | "retry",
  messages: AiGatewayMessage[],
  schema: z.ZodType<OUTPUT>,
  requestSchema: unknown,
  schemaName: string,
  promptCacheKey: string,
  options: AiGatewayOptions,
  fetcher: typeof fetch,
): Promise<OUTPUT> {
  options.signal?.throwIfAborted();
  options.onAttempt?.(attempt);
  const streaming = Boolean(options.onTextDelta || options.onReasoningSummary);
  const prompt = splitInstructions(messages);
  const reasoningEffort = AI_GATEWAY_REASONING_EFFORT_BY_TASK[options.taskType];
  const url = aiGatewayResponsesUrl(credentials);
  const metadata = {
    ...options.metadata,
    ai_model: AI_GATEWAY_MODEL,
    ai_provider: provider,
    ai_provider_attempt: attempt,
  };

  let response: Response;
  const requestSignal = AbortSignal.any([AbortSignal.timeout(options.requestTimeoutMs + 5_000), ...(options.signal ? [options.signal] : [])]);
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${credentials.token}`,
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "true",
        "cf-aig-request-timeout": String(options.requestTimeoutMs),
        "cf-aig-metadata": JSON.stringify(metadata),
      },
      body: JSON.stringify({
        model: AI_GATEWAY_MODEL,
        prompt_cache_key: promptCacheKey,
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        reasoning: {
          effort: reasoningEffort,
          summary: "auto",
          context: "current_turn",
        },
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema: requestSchema,
          },
        },
        input: prompt.input,
        ...(streaming ? { stream: true } : {}),
      }),
      signal: requestSignal,
    });
  } catch (error) {
    throw new AiGatewayResponseError({
      provider,
      status: null,
      gatewayLogId: "",
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const gatewayLogId = response.headers.get("cf-aig-log-id") ?? "";
  notifyTelemetry(options, { status: response.status, gatewayLogId });
  let responseText: string;
  try {
    const maxBytes = options.taskType === "credit_answer" ? MAX_CREDIT_GATEWAY_RESPONSE_BYTES : MAX_AI_GATEWAY_RESPONSE_BYTES;
    responseText = response.ok && streaming && response.body && response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.stringify(await readResponsesStream(response.body, options.onTextDelta ?? (() => {}), maxBytes, options.onReasoningSummary, requestSignal))
      : await readTextBounded(response, maxBytes, requestSignal);
  } catch (error) {
    throw new AiGatewayResponseError({
      provider,
      status: response.status,
      gatewayLogId,
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw new AiGatewayResponseError({
      provider,
      status: response.status,
      gatewayLogId,
      retryable:
        response.status === 408 || response.status === 429 || response.status >= 500,
      message: summarizeErrorResponse(responseText),
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw outputError(provider, response.status, gatewayLogId, "response body is not JSON");
  }
  const envelope = responseEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw outputError(
      provider,
      response.status,
      gatewayLogId,
      `invalid Responses envelope: ${schemaErrorSummary(envelope.error)}`,
    );
  }
  const usage = envelope.data.usage;
  const outputDetails = usage?.output_tokens_details;
  notifyTelemetry(options, { status: response.status, gatewayLogId,
    inputTokens: tokenCount(usage?.input_tokens), outputTokens: tokenCount(usage?.output_tokens),
    cachedInputTokens: tokenCount(usage?.input_tokens_details?.cached_tokens),
    reasoningTokens: tokenCount(isObject(outputDetails) ? outputDetails.reasoning_tokens : undefined),
  });
  if (envelope.data.status !== "completed") {
    const details =
      envelope.data.error?.message ??
      envelope.data.incomplete_details?.reason ??
      `Responses status ${envelope.data.status}`;
    throw outputError(provider, response.status, gatewayLogId, details);
  }
  const outputText = extractOutputText(envelope.data.output);
  if (!outputText.trim()) {
    throw outputError(provider, response.status, gatewayLogId, "Responses output_text is empty");
  }

  let output: unknown;
  try {
    output = JSON.parse(outputText);
  } catch {
    const diagnostics = options.taskType === "credit_answer" ? ` (phases=${JSON.stringify(envelope.data.output.filter(isObject).filter(x => x.type === "message").map(x => x.phase ?? "unspecified"))}, first_char=${JSON.stringify(outputText.trim()[0])}, chars=${outputText.length})` : "";
    throw outputError(provider, response.status, gatewayLogId, "output_text is not JSON" + diagnostics);
  }
  const validated = schema.safeParse(output);
  if (!validated.success) {
    throw outputError(
      provider,
      response.status,
      gatewayLogId,
      `output failed business schema: ${schemaErrorSummary(validated.error)}`,
    );
  }
  const reasoningSummary = reasoningSummaryMetrics(envelope.data.output);
  console.log(
    JSON.stringify({
      event: "ai_gateway_provider_succeeded",
      provider,
      provider_attempt: attempt,
      model: AI_GATEWAY_MODEL,
      task_type: options.taskType,
      reasoning_effort: reasoningEffort,
      requested_reasoning_summary: "auto",
      requested_reasoning_context: "current_turn",
      reasoning_summary_count: reasoningSummary.count,
      reasoning_summary_text_length: reasoningSummary.textLength,
      prompt_cache_key: envelope.data.prompt_cache_key ?? promptCacheKey,
      cached_input_tokens:
        envelope.data.usage?.input_tokens_details?.cached_tokens ?? null,
      cache_write_input_tokens:
        envelope.data.usage?.input_tokens_details?.cache_write_tokens ?? null,
      encrypted_reasoning_present: hasEncryptedReasoning(envelope.data.output),
      output_text_length: outputText.length,
      status: response.status,
      gateway_log_id: gatewayLogId,
    }),
  );
  return validated.data;
}

function splitInstructions(messages: AiGatewayMessage[]): {
  instructions: string | undefined;
  input: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = messages.filter(
    (message): message is { role: "user" | "assistant"; content: string } =>
      message.role !== "system",
  );
  return { instructions: instructions || undefined, input };
}

function extractOutputText(output: unknown[]): string {
  const texts: string[] = [];
  const messages = output.filter(isObject).filter(item => item.type === "message");
  const finals = messages.filter(item => item.phase === "final_answer");
  // A coding model can emit commentary before its structured final answer.
  // Preserve legacy unphased outputs, but never concatenate a preamble into JSON.
  for (const item of finals.length ? finals : messages.filter(item => item.phase !== "commentary")) {
    if (!Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  return texts.join("");
}

function hasEncryptedReasoning(output: unknown[]): boolean {
  return output.some(
    (item) =>
      isObject(item) &&
      item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0,
  );
}

function reasoningSummaryMetrics(output: unknown[]): {
  count: number;
  textLength: number;
} {
  let count = 0;
  let textLength = 0;
  for (const item of output) {
    if (!isObject(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) {
      continue;
    }
    for (const summary of item.summary) {
      if (
        !isObject(summary) ||
        summary.type !== "summary_text" ||
        typeof summary.text !== "string"
      ) {
        continue;
      }
      count += 1;
      textLength += summary.text.length;
    }
  }
  return { count, textLength };
}

function outputError(
  provider: string,
  status: number,
  gatewayLogId: string,
  message: string,
): AiGatewayResponseError {
  return new AiGatewayResponseError({
    provider,
    status,
    gatewayLogId,
    retryable: true,
    message,
  });
}

function summarizeErrorResponse(text: string): string {
  if (!text.trim()) return "empty error response";
  try {
    const payload = JSON.parse(text) as unknown;
    if (!isObject(payload)) return "non-success response";
    const error = payload.error;
    if (typeof error === "string") return error.slice(0, 500);
    if (isObject(error) && typeof error.message === "string") {
      return error.message.slice(0, 500);
    }
    if (typeof payload.message === "string") return payload.message.slice(0, 500);
  } catch {
    return "non-JSON error response";
  }
  return "non-success response";
}

function schemaErrorSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCredentials(credentials: AiGatewayCredentials): AiGatewayCredentials {
  return {
    accountId: requiredConfig("account ID", credentials.accountId),
    gatewayId: requiredConfig("gateway ID", credentials.gatewayId),
    token: requiredConfig("authentication token", credentials.token),
  };
}

function requiredConfig(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`AI Gateway ${label} is not configured`);
  return normalized;
}

function validateRequestTimeout(value: number): void {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_AI_GATEWAY_TIMEOUT_MS
  ) {
    throw new Error(
      `AI Gateway request timeout must be an integer between 1 and ${MAX_AI_GATEWAY_TIMEOUT_MS}`,
    );
  }
}

async function readTextBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`AI Gateway response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`AI Gateway response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
