import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { answerCreditQuestion, recoverQueuedCreditAnswers } from "../src/lib/server/credit-assistant.ts";
import { generateAiGatewayObject } from "../src/lib/server/ai-gateway.ts";
import { creditAnswerText } from "../src/lib/credit-assistant/types.ts";

const credentials = { accountId: "test", gatewayId: "default", token: "test-token" };
const key = "credit/public/2026年半年度报告.pdf";
const hit = { key, text: "2026年6月30日母公司资产总计426,403,159,812.34元。" };
const base = { question: "2026年6月末母公司资产总计是多少？", history: [], credentials,
  semanticSearch: async () => [hit] };

test("one question makes one direct search and one answer model call", async () => {
  const queries = [], names = [];
  const answer = await answerCreditQuestion({ ...base, semanticSearch: async query => { queries.push(query); return [hit]; },
    generate: async (_credentials, messages, schema, name, options) => {
      names.push(name);
      assert.equal(options.taskType, "credit_answer");
      assert.equal(messages.length, 2);
      const input = JSON.parse(messages[1].content);
      assert.equal(input.question, base.question);
      assert.equal(input.sources[0].text, hit.text);
      return schema.parse({ paragraphs: [{ text: "母公司资产总计为4,264.03亿元。", sourceIds: [input.sources[0].id] }],
        gaps: [], attachmentSourceIds: [] });
    } });
  assert.deepEqual(queries, [base.question]);
  assert.deepEqual(names, ["credit_answer"]);
  assert.equal(answer.status, "complete");
  assert.equal(answer.paragraphs[0].citations[0].sourceId, "search-1");
  assert.equal(answer.sources[0].documentId, key);
  assert.match(answer.files[0].url, /2026/);
  assert.match(creditAnswerText(answer), /资料来源/);
});

test("online search results are usable without a catalog or known customer", async () => {
  const answer = await answerCreditQuestion({ ...base, semanticSearch: async () => [
    { key: "credit/search/online-result.md", text: "线上检索到的信息。" }, hit,
  ], generate: async (_c, messages, schema) => {
    const input = JSON.parse(messages[1].content);
    assert.equal(input.sources.length, 2);
    return schema.parse({ paragraphs: [{ text: "线上检索到的信息。", sourceIds: [input.sources[0].id] }],
      gaps: [], attachmentSourceIds: [] });
  } });
  assert.equal(answer.paragraphs[0].text, "线上检索到的信息。");
  assert.equal(answer.sources[0].documentId, "credit/search/online-result.md");
  assert.equal(answer.sources[0].url, undefined);
  assert.deepEqual(answer.files, []);
});

test("answer text remains visible when the model omits source IDs", async () => {
  const answer = await answerCreditQuestion({ ...base, generate: async (_c, _messages, schema) => schema.parse({
    paragraphs: [{ text: "该片段没有完整披露报告期。", sourceIds: [] }], gaps: ["需要核对完整报告。"], attachmentSourceIds: [],
  }) });
  assert.equal(answer.status, "partial");
  assert.equal(answer.paragraphs[0].text, "该片段没有完整披露报告期。");
  assert.deepEqual(answer.sources, []);
});

test("empty online search returns an honest gap without calling the model", async () => {
  const answer = await answerCreditQuestion({ ...base, semanticSearch: async () => [],
    generate: async () => assert.fail("no model call without snippets") });
  assert.equal(answer.status, "insufficient");
  assert.match(answer.gaps[0], /未检索到/);
});

test("follow-up passes recent conversation and current online snippets", async () => {
  const priorAnswer = { status: "complete", paragraphs: [{ text: "上轮答复", citations: [] }], gaps: [], sources: [], files: [], createdAt: "2026-09-25" };
  const history = [{ id: "previous", question: "之前的问题", answer: priorAnswer, createdAt: priorAnswer.createdAt }];
  await answerCreditQuestion({ ...base, history, generate: async (_c, messages, schema) => {
    const input = JSON.parse(messages[1].content);
    assert.equal(input.history[0].question, "之前的问题");
    assert.deepEqual(input.history[0].answer, ["上轮答复"]);
    return schema.parse({ paragraphs: [], gaps: ["未在当前检索片段中找到。"], attachmentSourceIds: [] });
  } });
});

test("credit model stays on the configured Codex gateway with one attempt", async () => {
  const calls = [];
  await assert.rejects(generateAiGatewayObject(credentials, [{ role: "user", content: "test" }], z.object({ ok: z.boolean() }), "test",
    { taskType: "credit_answer", metadata: {}, promptCacheKey: "test", requestTimeoutMs: 1000 }, async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) }); return new Response("Unavailable", { status: 503 });
    }));
  assert.equal(calls.length, 1); assert.match(calls[0].url, /custom-codex\/responses$/);
  assert.equal(calls[0].body.model, "gpt-6-luna"); assert.equal(calls[0].body.reasoning.effort, "xhigh");
});

test("interrupted queued work is removed only after recovery is scheduled", async () => {
  const payload = { id: "12345678-1234-4123-8123-123456789abc", question: "请提供报告" };
  const job = { id: "queue-1", callback: "answerQuestion", payload };
  const events = [];
  await recoverQueuedCreditAnswers([job, { ...job, id: "unrelated", callback: "other" }, { ...job, payload: {} }],
    async value => events.push({ scheduled: value }), id => events.push({ removed: id }));
  assert.deepEqual(events, [{ scheduled: payload }, { removed: "queue-1" }]);
  await assert.rejects(recoverQueuedCreditAnswers([job], async () => { throw new Error("alarm unavailable"); },
    () => assert.fail("must retain queue row")), /alarm unavailable/);
});
