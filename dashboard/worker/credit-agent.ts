import { Agent, isDurableObjectCodeUpdateReset, isPlatformTransientError } from "agents";
import { tracing } from "cloudflare:workers";
import { answerCreditQuestion, recoverQueuedCreditAnswers } from "../src/lib/server/credit-assistant.ts";
import { AiGatewayResponseError } from "../src/lib/server/ai-gateway.ts";
import { creditQuestionSchema, type CreditSession } from "../src/lib/credit-assistant/types.ts";
import { CreditEventHub } from "../src/lib/server/credit-events.ts";
import { CreditExecutionError, creditFailure } from "../src/lib/server/credit-errors.ts";
import { CreditTrace, type CreditSpan } from "../src/lib/server/credit-tracing.ts";
import { listPublicCreditFiles } from "../src/lib/server/credit-public-files.ts";
import { searchPublicCreditDocuments } from "../src/lib/server/credit-search.ts";

export class CreditAgent extends Agent<Cloudflare.Env, CreditSession> {
  initialState: CreditSession = { turns: [], running: false, progress: "", error: null, startedAt: 0, pendingQuestion: "" };
  private events = new CreditEventHub();
  private latestAiProgress = "";

  private save(state: CreditSession) {
    this.setState(state);
    if (!state.running) {
      this.events.result(state);
      this.events.finish();
    }
  }

  private progress(progress: string) {
    this.save({ ...this.state, progress });
  }

  private aiProgress(summary: string) {
    const next = summary.trim();
    if (!next || next === this.latestAiProgress) return;
    this.latestAiProgress = next;
    this.events.progress(next);
  }

  async onStart(): Promise<void> {
    const question = this.state.pendingQuestion;
    if (!this.state.running || !question) return;
    await recoverQueuedCreditAnswers(this.getQueues("question", question),
      payload => this.schedule(1, "answerQuestion", payload, { idempotent: true }),
      id => this.dequeue(id));
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const state = this.state;
      return new URL(request.url).pathname.endsWith("/events")
        ? this.events.response(state, this.latestAiProgress, () => { this.sql`SELECT 1`; }) : Response.json(state);
    }
    if (request.method === "DELETE") {
      if (this.state.running) return Response.json({ error: "当前问答仍在处理中" }, { status: 409 });
      this.latestAiProgress = "";
      this.save({ ...this.initialState, turns: [], conversationId: crypto.randomUUID() });
      return Response.json(this.state);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (this.state.running) return Response.json({ error: "请等待当前答复完成" }, { status: 409 });
    const newSession = new URL(request.url).pathname.endsWith("/new");
    if (!newSession && (this.state.turns.length >= 30 || new TextEncoder().encode(JSON.stringify(this.state)).byteLength > 1_000_000)) {
      return Response.json({ error: "本会话已达容量上限，请新建会话" }, { status: 409 });
    }
    const input: unknown = await request.json();
    if (newSession) {
      if (this.state.turns.length || this.state.pendingQuestion) {
        this.sql`CREATE TABLE IF NOT EXISTS credit_conversation_archive (id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
        this.sql`INSERT INTO credit_conversation_archive (id, state) VALUES (${this.state.conversationId ?? crypto.randomUUID()}, ${JSON.stringify(this.state)})`;
      }
      this.latestAiProgress = "";
      this.save({ ...this.initialState, turns: [], conversationId: crypto.randomUUID() });
      return Response.json(this.state);
    }
    const parsed = creditQuestionSchema.safeParse(input);
    if (!parsed.success) return Response.json({ error: "请输入问题。" }, { status: 400 });
    const id = crypto.randomUUID();
    this.latestAiProgress = "";
    const progress = "正在检索资料";
    this.save({ ...this.state, conversationId: this.state.conversationId ?? crypto.randomUUID(), running: true, progress,
      questionId: id, error: null, startedAt: Date.now(), pendingQuestion: parsed.data.question });
    try {
      await this.schedule(1, "answerQuestion", { question: parsed.data.question, id }, { idempotent: true });
    } catch {
      this.save({ ...this.state, running: false, progress: "", error: "问答任务创建失败，请重试" });
      return Response.json({ error: this.state.error }, { status: 503 });
    }
    return Response.json(this.state, { status: 202 });
  }

  async answerQuestion(payload: { question: string; id: string }): Promise<void> {
    if (this.state.turns.some(t => t.id === payload.id)) return;
    if (!this.state.running || (this.state.questionId && this.state.questionId !== payload.id) || this.state.pendingQuestion !== payload.question) return;
    const agentId = this.ctx.id.toString();
    const trace = new CreditTrace(tracing, { agentId, runId: payload.id,
      conversationId: this.state.conversationId ?? `legacy-${agentId}` });
    return trace.agent(span => this.executeAnswer(payload, trace, span));
  }

  private async executeAnswer(payload: { question: string; id: string }, trace: CreditTrace, span: CreditSpan): Promise<void> {
    const started = Date.now();
    let modelCalls = 0, searchCalls = 0;
    try {
      if (Date.now() - this.state.startedAt >= 12 * 60_000) throw new CreditExecutionError("deadline", "本次问答已达到总时限");
      const generated = await answerCreditQuestion({ question: payload.question, history: this.state.turns,
        credentials: { accountId: this.env.CLOUDFLARE_ACCOUNT_ID, gatewayId: this.env.AI_GATEWAY_ID, token: this.env.CF_AIG_TOKEN },
        progress: progress => this.progress(progress),
        summary: summary => this.aiProgress(summary),
        modelStarted: () => { modelCalls++; },
        runId: payload.id, trace,
        semanticSearch: async query => {
          const documents = await listPublicCreditFiles(this.env.EASTMONEY);
          const result = await searchPublicCreditDocuments(this.env.CREDIT_SEARCH, documents, query, 50);
          searchCalls += result.searchCalls;
          console.log(JSON.stringify({ event: "credit_search_completed", run_id: payload.id,
            source_count: result.chunks.length, requested_years: result.requestedYears,
            found_years: result.foundYears }));
          return result.chunks.map(c => ({ id: c.id, key: c.item.key, text: c.text }));
        },
      });
      const answer = generated;
      console.log(JSON.stringify({ event: "credit_answer_completed", run_id: payload.id, elapsed_ms: Date.now() - started,
        model_calls: modelCalls, search_calls: searchCalls, answer_status: answer.status }));
      this.save({ ...this.state, turns: [...this.state.turns, { id: payload.id, question: payload.question, answer, createdAt: answer.createdAt }],
        running: false, progress: "", error: null, pendingQuestion: "" });
      span.set({ "credit.outcome": answer.status });
    } catch (error) {
      span.fail(error);
      // The SDK preserves one-shot schedules across platform resets. Do not
      // turn a deploy interruption into a failed user answer or write to a dead isolate.
      if (!(error instanceof AiGatewayResponseError) && isPlatformTransientError(error)) {
        span.set({ "credit.outcome": "recovering" });
        console.warn(JSON.stringify({ event: "credit_answer_recovering", run_id: payload.id,
          reason: isDurableObjectCodeUpdateReset(error) ? "code_updated" : "platform_reset" }));
        this.events.finish();
        throw error;
      }
      const failure = creditFailure(error);
      console.error(JSON.stringify({ event: "credit_answer_failed", run_id: payload.id, code: failure.code,
        elapsed_ms: Date.now() - started, model_calls: modelCalls, search_calls: searchCalls,
        error_type: error instanceof Error ? error.name : "unknown",
        ...(error instanceof AiGatewayResponseError ? { provider: error.provider, status: error.status, gateway_log_id: error.gatewayLogId,
        } : {}),
      }));
      const message = `${failure.message}（错误编号：${payload.id}）`;
      this.save({ ...this.state, running: false, progress: "", error: message });
    } finally {
      span.set({ "credit.model_calls": modelCalls, "credit.search_calls": searchCalls });
    }
  }
}
