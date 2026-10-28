import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readSse } from '../src/lib/sse.ts';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('$lib/')) return next(new URL('../src/lib/' + specifier.slice(5) + '.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
const { POST } = await import('../src/routes/api/market-briefing/+server.ts');
const env = { CLOUDFLARE_ACCOUNT_ID: 'test', AI_GATEWAY_ID: 'test', CF_AIG_TOKEN: 'test', DATA: { async fetch(request) {
  if (request.url.includes('/stock-summary')) return Response.json({ title: '股市收评', time: '2026-09-11T15:00:00', paragraphs: ['股市新闻'] });
  return Response.json([]);
} } };
function event() {
  const url = new URL('https://example.test/api/market-briefing?date=2026-09-11');
  return { url, request: new Request(url, { method: 'POST', headers: { Accept: 'text/event-stream' } }), platform: { env } };
}

test('路由立即建立 SSE，透传公开摘要，终帧返回经校验的股债正文', async () => {
  const original = globalThis.fetch;
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  globalThis.fetch = async () => new Response(
    frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '分析股市催化' }) +
    frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({ stock: '股市正文。', bond: '债市正文。' }) }] }] } }),
    { headers: { 'content-type': 'text/event-stream' } });
  try {
    const response = await POST(event());
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const received = [];
    await readSse(response.body, e => received.push({ event: e.event, data: e.event === 'result' ? JSON.parse(e.data) : e.data }), 10000);
    assert.deepEqual(received[0], { event: 'progress', data: '分析股市催化' });
    assert.deepEqual(received.at(-1), { event: 'result', data: { report_date: '2026-09-11', stock: '股市正文。', bond: '债市正文。', news_count: 1 } });
  } finally { globalThis.fetch = original; }
});

test('断开 SSE 取消上游调用，不触发重试；错误以 error 终帧返回', async () => {
  const original = globalThis.fetch;
  let signal, calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  try {
    const response = await POST(event());
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(signal);
    await response.body.cancel();
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('bad request', { status: 400 });
    const failed = await POST(event());
    const events = [];
    await readSse(failed.body, e => events.push(e.event), 10000);
    assert.equal(events.at(-1), 'error');
    assert.equal(events.includes('result'), false);
  } finally { globalThis.fetch = original; }
});
