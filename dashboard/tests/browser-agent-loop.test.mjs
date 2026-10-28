import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { runBrowserAgent, listBrowserTools } = await import('../src/lib/browser-agent.ts');
const { AI_GATEWAY_MODEL } = await import('../src/lib/agent-model.ts');

function envelope(id, output, status = 'completed') {
  return { id, object: 'response', created_at: 1, status, model: AI_GATEWAY_MODEL, output,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    error: null, incomplete_details: null, parallel_tool_calls: true, tools: [] };
}
function sse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
function textEvents(text) {
  const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: envelope('r_2', [], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: envelope('r_2', [item]) },
  ];
}
function toolEvents() {
  const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'credit_public_search', arguments: '{"query":"授信"}', status: 'completed' };
  return [
    { type: 'response.created', response: envelope('r_1', [], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: item.arguments },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: envelope('r_1', [item]) },
  ];
}

test('browser ToolLoopAgent streams, calls a user-authorized MCP tool, and resumes the model', async () => {
  const oldFetch = globalThis.fetch;
  const oldLocation = globalThis.location;
  globalThis.location = new URL('https://eastmoney.hasbai.xyz/credit-workbench');
  const tool = { name: 'credit_public_search', title: '检索公开授信材料', description: '检索授信 PDF',
    inputSchema: { type: 'object', properties: { query: { type: 'string', pattern: '^.+$' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true } };
  const article = { name: 'article', title: '读取研报正文',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[\\p{L}\\p{N}_|.-]+$' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } };
  let modelCalls = 0, toolCalls = 0;
  const events = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/mcp')) {
      const rpc = JSON.parse(init.body);
      assert.equal(init.credentials, 'same-origin');
      if (rpc.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [tool, article] } });
      toolCalls++;
      assert.equal(rpc.method, 'tools/call');
      assert.deepEqual(rpc.params, { name: tool.name, arguments: { query: '授信' } });
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { sources: [{ text: '授信余额 10 亿元', title: '公开报告', url: '/api/credit-assistant/files/0123456789abcdef01234567' }] } } });
    }
    assert.ok(url.endsWith('/api/ai/responses'), url);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    const body = JSON.parse(init.body);
    assert.equal(body.model, AI_GATEWAY_MODEL);
    assert.deepEqual(body.tools.map(item => item.name).sort(), ['article', 'credit_public_search']);
    assert.equal(JSON.stringify(body.tools).includes('"pattern"'), false);
    assert.equal(article.inputSchema.properties.id.pattern, '^[\\p{L}\\p{N}_|.-]+$');
    modelCalls++;
    if (modelCalls === 2) assert.ok(body.input.some(item => item.type === 'function_call_output'));
    return sse(modelCalls === 1 ? toolEvents() : textEvents('依据公开报告，授信余额为 10 亿元。'));
  };
  try {
    const available = await listBrowserTools();
    const result = await runBrowserAgent({ messages: [{ role: 'user', content: '查询授信' }], tools: available,
      selectedNames: new Set([tool.name, article.name]), readOnly: true, maxSteps: 3, signal: new AbortController().signal,
      approve: async () => { throw new Error('read-only tool must not request approval'); },
      onEvent: event => events.push(event),
    });
    assert.equal(modelCalls, 2);
    assert.equal(toolCalls, 1);
    assert.match(result.text, /10 亿元/);
    assert.ok(result.messages.length >= 2);
    assert.ok(events.some(event => event.type === 'tool-call'));
    assert.equal(events.find(event => event.type === 'tool-result')?.sources?.[0]?.title, '公开报告');
    assert.ok(events.some(event => event.type === 'text'));
  } finally { globalThis.fetch = oldFetch; globalThis.location = oldLocation; }
});
