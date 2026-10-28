import assert from "node:assert/strict";
import test from "node:test";
import { creditQuestionSchema } from "../src/lib/credit-assistant/types.ts";
import { answerCreditQuestion } from "../src/lib/server/credit-assistant.ts";

const key = "credit/public/2026半年报.pdf";
const credentials = { accountId: "test", gatewayId: "test", token: "test" };

test("question API accepts ordinary text without institution or directory state", () => {
  assert.equal(creditQuestionSchema.safeParse({ question: "报告" }).success, true);
  assert.equal(creditQuestionSchema.safeParse({ question: "   " }).success, false);
  assert.equal(creditQuestionSchema.safeParse({ question: "报告", institutionName: "银行" }).success, false);
});

test("online PDF snippets supply answer and original-file links directly", async () => {
  const answer = await answerCreditQuestion({ question: "资产总计是多少？", history: [], credentials,
    semanticSearch: async () => [{ key, text: "资产总计426,403,159,812.34元" }],
    generate: async (_c, messages, schema) => {
      const id = JSON.parse(messages[1].content).sources[0].id;
      return schema.parse({ paragraphs: [{ text: "资产总计为426,403,159,812.34元。", sourceIds: [id] }], gaps: [], attachmentSourceIds: [id] });
    } });
  assert.equal(answer.sources[0].documentId, key);
  assert.match(answer.files[0].url, /^\/api\/credit-assistant\/files\//);
  assert.equal(answer.files[0].url, answer.sources[0].url);
});
