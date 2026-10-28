import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { readSse, readResponsesStream } from "../src/lib/server/ai-stream.ts";
import { AiGatewayResponseError, generateAiGatewayObject } from "../src/lib/server/ai-gateway.ts";

const encoder = new TextEncoder();
const credentials = { accountId: "test", gatewayId: "test", token: "test" };
const byteStream = text => new ReadableStream({ start(controller) {
  for (const byte of encoder.encode(text)) controller.enqueue(Uint8Array.of(byte));
  controller.close();
} });
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;

test("SSE decoding preserves split Chinese UTF-8, CRLF, multiline events and trailing frames", async () => {
  const received = [];
  await readSse(byteStream(': heartbeat\r\nevent: progress\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata: 尾帧'), value => received.push(value), 1000);
  assert.deepEqual(received, [{ event: "progress", data: "第一行\n第二行" }, { event: "message", data: "尾帧" }]);
  await assert.rejects(readSse(byteStream("data: oversized"), () => {}, 4), /size limit/);
});

test("Responses streaming delivers output before completion and excludes reasoning and commentary", async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const received = [];
  const complete = { status: "completed", output: [{ type: "message", phase: "final_answer", content: [{ type: "output_text", text: '{"ok":true}' }] }] };
  const pending = readResponsesStream(body, text => received.push(text), 10000);
  for (const value of [
    { type: "response.reasoning_summary_text.delta", delta: "private reasoning" },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "commentary" } },
    { type: "response.output_text.delta", output_index: 0, delta: "tool preamble" },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", phase: "final_answer" } },
    { type: "response.output_text.delta", output_index: 1, delta: '{"ok":' },
  ]) controller.enqueue(encoder.encode(event(value)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, ['{"ok":']);
  controller.enqueue(encoder.encode(event({ type: "response.output_text.delta", output_index: 1, delta: "true}" })));
  controller.enqueue(encoder.encode(event({ type: "response.completed", response: complete })));
  controller.close();
  assert.deepEqual(await pending, complete);
  assert.equal(received.join(""), '{"ok":true}');
  await assert.rejects(readResponsesStream(byteStream(event({ type: "response.output_text.delta", delta: "partial" })), () => {}, 1000), /before response completion/);
});

test("streaming gateway uses the existing provider and validates the completed business schema", async () => {
  const deltas = [];
  const telemetry = [];
  const options = { taskType: "credit_answer", metadata: {}, promptCacheKey: "test-stream", requestTimeoutMs: 1000,
    onTextDelta: text => deltas.push(text), onTelemetry: metadata => telemetry.push(metadata) };
  const response = value => new Response(byteStream(event({ type: "response.output_text.delta", delta: JSON.stringify(value) })
    + event({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 400, output_tokens: 40,
      input_tokens_details: { cached_tokens: 200 }, output_tokens_details: { reasoning_tokens: 30 } },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] } })),
  { headers: { "content-type": "text/event-stream", "cf-aig-log-id": "stream-test" } });
  const output = await generateAiGatewayObject(credentials, [{ role: "user", content: "test" }], z.object({ ok: z.boolean() }), "test", options,
    async (url, init) => { assert.match(url, /custom-codex\/responses$/); assert.equal(JSON.parse(init.body).stream, true); return response({ ok: true }); });
  assert.deepEqual(output, { ok: true }); assert.equal(deltas.join(""), '{"ok":true}');
  assert.deepEqual(telemetry.at(-1), { status: 200, gatewayLogId: "stream-test", inputTokens: 400, outputTokens: 40, cachedInputTokens: 200, reasoningTokens: 30 });
  await assert.rejects(generateAiGatewayObject(credentials, [], z.object({ ok: z.boolean() }), "test", options,
    async () => response({ ok: "wrong" })), /business schema/);
});
