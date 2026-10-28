import assert from "node:assert/strict";
import test from "node:test";
import { answerCreditQuestion } from "../src/lib/server/credit-assistant.ts";
import { creditFailure, CreditExecutionError } from "../src/lib/server/credit-errors.ts";
import { AiGatewayResponseError } from "../src/lib/server/ai-gateway.ts";
import { CreditEventHub } from "../src/lib/server/credit-events.ts";

const base = { question: "流动资产多少", history: [], credentials: { accountId: "test", gatewayId: "test", token: "test" } };

test("direct RAG passes returned chunks to the answer model", async () => {
  let searches = 0, calls = 0;
  await answerCreditQuestion({ ...base, semanticSearch: async query => {
    searches++; assert.equal(query, base.question);
    return Array.from({ length: 20 }, (_, i) => ({ key: `credit/public/报告${i}.pdf`, text: `资产${i}亿元` }));
  }, generate: async (_c, messages, schema) => {
    calls++; assert.equal(JSON.parse(messages[1].content).sources.length, 20);
    return schema.parse({ paragraphs: [], gaps: ["仍需核对"], attachmentSourceIds: [] });
  } });
  assert.equal(searches, 1); assert.equal(calls, 1);
});

test("upstream failures are surfaced without leaking provider bodies", () => {
  for (const [status, message, code] of [[429, "token=secret", "model_busy"], [504, "timeout", "model_timeout"], [403, "private body", "model_configuration"], [200, "bad JSON", "model_output"], [502, "secret", "model_unavailable"]]) {
    const failure = creditFailure(new AiGatewayResponseError({ provider: "custom-codex", status, gatewayLogId: "log", retryable: true, message }));
    assert.equal(failure.code, code); assert.doesNotMatch(failure.message, /secret|private body|bad JSON/);
  }
  assert.equal(creditFailure(new CreditExecutionError("deadline", "private")).code, "deadline");
});

test("an obsolete SSE subscriber closes on the next heartbeat so a new client can resubscribe", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const hub = new CreditEventHub();
  const response = hub.response({ turns: [], running: true, progress: "", error: null, startedAt: 0 }, "", () => { throw new Error("code updated"); });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  t.mock.timers.tick(20_000);
  assert.equal((await reader.read()).done, true);
});
