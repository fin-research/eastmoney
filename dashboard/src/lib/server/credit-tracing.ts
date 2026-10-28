import { AI_GATEWAY_MODEL, AI_GATEWAY_PROVIDER, AiGatewayResponseError, type AiGatewayTelemetry } from "./ai-gateway.ts";
import { creditFailure } from "./credit-errors.ts";

// Portable capability port for Node/Svelte tests. The real Workers export is
// structurally type-checked where CreditAgent injects it; no runtime shim/import here.
interface RuntimeSpan { setAttribute(key: string, value: string | number | boolean): void }
export interface CreditTracing {
  enterSpan<T>(name: string, callback: (span: RuntimeSpan) => T): T;
}
type Outcome = "ok" | "error" | "complete" | "partial" | "insufficient" | "recovering";
export type CreditTraceAttributes = {
  "credit.stage"?: "decision";
  "credit.outcome"?: Outcome;
  "credit.source_count"?: number;
  "credit.model_calls"?: number;
  "credit.search_calls"?: number;
};
type Attributes = Record<string, string | number | boolean | undefined>;
type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Only application-owned metadata enters spans. Never serialize prompts, results or errors. */
export class CreditSpan {
  private runtime: RuntimeSpan | undefined;
  private outcome: Outcome = "ok";
  constructor(runtime?: RuntimeSpan, attributes: Attributes = {}) { this.runtime = runtime; this.annotate(attributes); }
  private attribute(key: string, value: string | number | boolean | undefined) {
    if (value === undefined || typeof value === "number" && !Number.isFinite(value)) return;
    try { this.runtime?.setAttribute(key, value); } catch { /* Observability must not fail the answer. */ }
  }
  set(attributes: CreditTraceAttributes) {
    if (attributes["credit.outcome"]) this.outcome = attributes["credit.outcome"];
    for (const [key, value] of Object.entries(attributes)) this.attribute(key, value);
  }
  private annotate(attributes: Attributes) {
    for (const [key, value] of Object.entries(attributes)) this.attribute(key, value);
  }
  finish(started: number) { this.attribute("credit.duration_ms", Date.now() - started); }
  modelResponse(metadata: AiGatewayTelemetry) {
    this.annotate({
      "http.response.status_code": metadata.status,
      "cloudflare.ai_gateway.log_id": /^[\w-]{1,200}$/.test(metadata.gatewayLogId) ? metadata.gatewayLogId : undefined,
      "gen_ai.usage.input_tokens": metadata.inputTokens,
      "gen_ai.usage.output_tokens": metadata.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": metadata.cachedInputTokens,
      "gen_ai.usage.reasoning.output_tokens": metadata.reasoningTokens,
    });
  }
  fail(error: unknown) {
    if (this.outcome !== "recovering") this.set({ "credit.outcome": "error" });
    this.annotate({ "error.type": creditFailure(error).code });
    if (error instanceof AiGatewayResponseError) this.modelResponse({ status: error.status ?? undefined, gatewayLogId: error.gatewayLogId });
  }
}

/** One instance per answer attempt; async parentage belongs to the Workers tracing runtime. */
export class CreditTrace {
  private runtime: CreditTracing | undefined;
  private identity: Attributes;
  constructor(runtime?: CreditTracing, identity?: { agentId: string; conversationId: string; runId: string }) {
    this.runtime = runtime;
    this.identity = identity ? {
      "gen_ai.agent.name": "CreditAgent",
      "gen_ai.agent.id": identity.agentId,
      "gen_ai.conversation.id": identity.conversationId,
      "credit.run_id": identity.runId,
    } : {};
  }
  agent<T>(callback: (span: CreditSpan) => T | Promise<T>): Promise<T> {
    return this.run("invoke_agent CreditAgent", { "gen_ai.operation.name": "invoke_agent" }, callback);
  }
  chat<T>(attributes: CreditTraceAttributes, callback: (span: CreditSpan) => T | Promise<T>): Promise<T> {
    return this.run(`chat ${AI_GATEWAY_MODEL}`, { ...attributes, "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": AI_GATEWAY_PROVIDER, "gen_ai.request.model": AI_GATEWAY_MODEL,
      "credit.reasoning_effort": "xhigh" }, callback);
  }
  tool<T>(name: "ai_search",
    attributes: CreditTraceAttributes, callback: (span: CreditSpan) => T | Promise<T>): Promise<T> {
    return this.run(`execute_tool ${name}`, { ...attributes, "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name }, callback);
  }
  private async run<T>(name: string, attributes: Attributes, callback: (span: CreditSpan) => T | Promise<T>): Promise<T> {
    if (!this.runtime) return callback(new CreditSpan());
    let pending: Promise<Result<T>> | undefined;
    const invoke = (runtime?: RuntimeSpan): Promise<Result<T>> => pending ??= (async () => {
      const started = Date.now();
      const span = new CreditSpan(runtime, { ...this.identity, "credit.outcome": "ok", ...attributes });
      try { return { ok: true, value: await callback(span) }; }
      catch (error) {
        span.fail(error);
        // Do not pass business errors through enterSpan: automatic exception
        // recording must not capture upstream bodies or material-validation text.
        return { ok: false, error };
      } finally { span.finish(started); }
    })();
    try { await this.runtime.enterSpan(name, runtime => invoke(runtime)); }
    catch { /* Reuse the same callback promise even if the tracing runtime fails. */ }
    const result = await (pending ?? invoke());
    if (!result.ok) throw result.error;
    return result.value;
  }
}
