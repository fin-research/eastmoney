import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readResponsesStream } from '../src/lib/server/ai-stream.ts';
import { generateAiGatewayObject } from '../src/lib/server/ai-gateway.ts';
import { generateMarketBriefing } from '../src/api.ts';

const encoder = new TextEncoder();
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const response = (output = { stock: '股市正文', bond: '债市正文' }) => ({ status: 'completed', output: [{ type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });

test('公开摘要在完成前流入，delta/done/summary 数组去重，不泄漏原始 reasoning 或工具参数', async () => {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const summaries = [], texts = [];
  const pending = readResponsesStream(body, text => texts.push(text), 10000, summary => summaries.push(summary));
  for (const value of [
    { type: 'response.reasoning_text.delta', delta: 'raw secret' },
    { type: 'response.function_call_arguments.delta', delta: 'tool secret' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '**正在分析' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '股市**' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '**正在分析股市**' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: '**正在分析股市**' }, { type: 'summary_text', text: '**正在分析债市**' }] } },
  ]) controller.enqueue(encoder.encode(frame(value)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(summaries, [{ id: '0:0', text: '正在分析' }, { id: '0:0', text: '正在分析股市' }, { id: '0:1', text: '正在分析债市' }]);
  assert.deepEqual(texts, []);
  controller.enqueue(encoder.encode(frame({ type: 'response.completed', response: response() })));
  controller.close();
  await pending;
});

test('仅订阅摘要也启用 SSE；不完整股债结果同模型重试，取消不重试', async () => {
  const attempts = [];
  let count = 0;
  const options = { taskType: 'market_briefing', metadata: {}, promptCacheKey: 'test', requestTimeoutMs: 1000, onReasoningSummary() {}, onAttempt: value => attempts.push(value) };
  const credentials = { accountId: 'test', gatewayId: 'test', token: 'test' };
  const schema = z.object({ stock: z.string().min(1), bond: z.string().min(1) });
  const output = await generateAiGatewayObject(credentials, [], schema, 'test', options, async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(frame({ type: 'response.completed', response: response(++count === 1 ? { stock: '股市' } : undefined) }), { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.deepEqual(attempts, ['primary', 'retry']);
  assert.equal(output.bond, '债市正文');
  const abort = new AbortController();
  count = 0;
  await assert.rejects(generateAiGatewayObject(credentials, [], schema, 'test', { ...options, signal: abort.signal }, async (_url, init) => {
    count++;
    abort.abort();
    init.signal.throwIfAborted();
  }), { name: 'AbortError' });
  assert.equal(count, 1);
});

test('浏览器市场点评统一通过 AI 客户端校验完整结果和日期', async () => {
  const complete = { report_date: '2026-09-11', stock: '股市', bond: '债市', news_count: 2 };
  const calls = [];
  const aiClient = { async run(options) { calls.push(options); return options.parse(complete); } };
  assert.deepEqual(await generateMarketBriefing(aiClient, '2026-09-11'), complete);
  assert.equal(calls[0].title, '市场点评 · 今日聚焦');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, '/api/market-briefing?date=2026-09-11');
  await assert.rejects(
    generateMarketBriefing({ async run(options) { return options.parse({ ...complete, stock: '' }); } }, '2026-09-11'),
  );
  await assert.rejects(
    generateMarketBriefing({ async run(options) { return options.parse({ ...complete, report_date: '2026-09-10' }); } }, '2026-09-11'),
    /报告日期与请求日期不一致/,
  );
});

test('今日聚焦生成期间保留草稿，完成由前端编号', async () => {
  await promisify(execFile)(process.execPath, ['--conditions=browser', 'tests/helpers/market-focus-lifecycle.mjs'], { cwd: new URL('../', import.meta.url), timeout: 20000, maxBuffer: 20000 });
});
