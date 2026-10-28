import assert from "node:assert/strict";
import test from "node:test";

import { createAiSseResponse, encodeAiSse } from "../src/lib/server/ai-sse.ts";
import { CreditEventHub } from "../src/lib/server/credit-events.ts";
import { readSse } from "../src/lib/sse.ts";

const decoder = new TextDecoder();

test("AI SSE uses native event types, plain-text progress and one complete JSON result", async () => {
  assert.equal(
    decoder.decode(encodeAiSse("progress", "分析股市\n分析债市")),
    "event: progress\ndata: 分析股市\ndata: 分析债市\n\n",
  );
  assert.equal(
    decoder.decode(encodeAiSse("result", { ok: true })),
    'event: result\ndata: {"ok":true}\n\n',
  );

  const request = new Request("https://example.test/api/ai", { method: "POST" });
  const response = createAiSseResponse(request, async ({ progress }) => {
    progress(" **正在分析** ");
    progress("__正在分析__");
    progress("正在形成结论");
    return { answer: "完整结果" };
  }, { errorMessage: () => "生成失败" });
  const events = [];
  await readSse(response.body, event => events.push({ event: event.event, data: event.data }), 10_000);
  assert.deepEqual(events, [
    { event: "progress", data: "正在分析" },
    { event: "progress", data: "正在形成结论" },
    { event: "result", data: '{"answer":"完整结果"}' },
  ]);
  assert.doesNotMatch(events[0].data, /"type"|"id"/);
  assert.doesNotMatch(events[0].data, /\*\*/);
});

test("credit SSE also strips Markdown bold markers from restored progress", async () => {
  const hub = new CreditEventHub();
  const response = hub.response(
    { turns: [], running: true, progress: "", error: null, startedAt: 0 },
    "**正在核对授信材料**",
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "retry: 2000\n\n");
  assert.equal(
    decoder.decode((await reader.read()).value),
    "event: progress\ndata: 正在核对授信材料\n\n",
  );
  await reader.cancel();
});

test("AI SSE emits a plain-text error without a result frame", async () => {
  const response = createAiSseResponse(
    new Request("https://example.test/api/ai"),
    async () => { throw new Error("private upstream detail"); },
    { errorMessage: () => "公开错误" },
  );
  const events = [];
  await readSse(response.body, event => events.push({ event: event.event, data: event.data }), 10_000);
  assert.deepEqual(events, [{ event: "error", data: "公开错误" }]);
});
