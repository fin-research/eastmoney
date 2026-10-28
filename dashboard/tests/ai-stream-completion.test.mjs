import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { readResponsesStream } from '../src/lib/server/ai-stream.ts';
import { generateAiGatewayObject } from '../src/lib/server/ai-gateway.ts';

const encoder = new TextEncoder();
const frame = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

test('terminal Responses events finish without EOF or waiting for upstream cancellation', { timeout: 1000 }, async () => {
  for (const status of ['completed', 'failed', 'incomplete']) {
    let cancelled = false;
    const response = { status, output: [] };
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(frame({ type: `response.${status}`, response })); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    assert.deepEqual(await readResponsesStream(stream, () => {}, 1000), response);
    assert.equal(cancelled, true);
  }
});

test('abort interrupts a stalled Responses reader even when source cancellation never settles', { timeout: 1000 }, async () => {
  let cancelled = false;
  const abort = new AbortController();
  const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const pending = readResponsesStream(stream, () => {}, 1000, undefined, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('malformed terminal events fail instead of waiting indefinitely', { timeout: 1000 }, async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(frame({ type: 'response.completed' })); } });
  await assert.rejects(readResponsesStream(stream, () => {}, 1000), /terminal event has no response/);
});

test('caller cancellation terminates both JSON and SSE response bodies without retrying', { timeout: 1000 }, async () => {
  for (const streaming of [false, true]) {
    const abort = new AbortController();
    let calls = 0, cancelled = false;
    const pending = generateAiGatewayObject({ accountId: 'test', gatewayId: 'default', token: 'test' }, [],
      z.object({ ok: z.boolean() }), 'test', {
        taskType: 'commentary', metadata: {}, promptCacheKey: 'test', requestTimeoutMs: 1000,
        signal: abort.signal, ...(streaming ? { onTextDelta() {} } : {}),
      }, async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }),
          { headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } });
      });
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});
