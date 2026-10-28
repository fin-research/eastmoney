import assert from "node:assert/strict";
import test from "node:test";
import { CreditTrace } from "../src/lib/server/credit-tracing.ts";
import { answerCreditQuestion } from "../src/lib/server/credit-assistant.ts";
import { recordingCreditTracing } from "./helpers/credit-trace-recorder.mjs";

const identity = { agentId: "agent", conversationId: "conversation", runId: "run" };
const credentials = { accountId: "test", gatewayId: "default", token: "secret-test-token" };
const capture = () => { const recorded = recordingCreditTracing(); return { ...recorded, trace: new CreditTrace(recorded.tracing, identity) }; };

test("direct answer traces exactly one search and one model call", async () => {
  const recorded = capture();
  const answer = await recorded.trace.agent(() => answerCreditQuestion({ question: "公司资产多少", history: [], credentials,
    trace: recorded.trace, semanticSearch: async () => [{ key: "credit/public/报告.pdf", text: "资产100亿元" }],
    generate: async (_c, messages, schema, _name, options) => {
      options.onTelemetry({ status: 200, gatewayLogId: "gateway-1", inputTokens: 100, outputTokens: 20 });
      const id = JSON.parse(messages[1].content).sources[0].id;
      return schema.parse({ paragraphs: [{ text: "资产100亿元", sourceIds: [id] }], gaps: [], attachmentSourceIds: [] });
    } }));
  assert.equal(answer.status, "complete");
  assert.deepEqual(recorded.spans.map(span => span.name), ["invoke_agent CreditAgent", "execute_tool ai_search", "chat gpt-6-luna"]);
  assert.equal(recorded.spans[2].attributes["gen_ai.usage.input_tokens"], 100);
  assert.ok(recorded.spans.every(span => span.ended && span.attributes["credit.run_id"] === "run"));
  assert.doesNotMatch(JSON.stringify(recorded.spans.map(span => span.attributes)), /资产100亿元|secret-test-token/);
});

test("search errors propagate without a local corpus fallback", async () => {
  const recorded = capture();
  await assert.rejects(recorded.trace.agent(() => answerCreditQuestion({ question: "公司资产多少", history: [], credentials,
    trace: recorded.trace, semanticSearch: async () => { throw new Error("search unavailable"); },
    generate: async () => assert.fail("model should not start") })), /search unavailable/);
  assert.equal(recorded.spans.find(span => span.name === "execute_tool ai_search").attributes["credit.outcome"], "error");
  assert.ok(!recorded.spans.some(span => span.name.startsWith("chat ")));
});

test("tracing failures before or after invocation and during attributes never replay, hide or fail business work", async () => {
  for (const mode of ["before", "after", "attributes", "twice"]) {
    let calls = 0;
    const runtime = { async enterSpan(_name, callback) {
      if (mode === "before") throw new Error("tracing unavailable");
      const span = { setAttribute() { if (mode === "attributes") throw new Error("tracing attribute failed"); } };
      const pending = callback(span);
      if (mode === "twice") await callback(span);
      await pending;
      throw new Error("tracing submit failed");
    } };
    const trace = new CreditTrace(runtime, identity);
    assert.equal(await trace.agent(() => { calls++; return "business result"; }), "business result");
    assert.equal(calls, 1);
    const businessError = new Error("original business error");
    await assert.rejects(trace.agent(() => { calls++; throw businessError; }), error => error === businessError);
    assert.equal(calls, 2);
  }
});

test("a model span stays open until streamed output processing and validation settle", async () => {
  const recorded = capture();
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const run = recorded.trace.agent(() => recorded.trace.chat({ "credit.stage": "decision" }, async () => {
    entered(); await gate; return "validated final result";
  }));
  await ready;
  assert.equal(recorded.spans[1].ended, false);
  assert.equal(recorded.spans[0].ended, false);
  release();
  assert.equal(await run, "validated final result");
  assert.ok(recorded.spans.every(span => span.ended));
});
