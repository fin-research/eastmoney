import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';

const toolCatalog = { jsonrpc: '2.0', id: 'fixture', result: { tools: [
  { name: 'credit_public_materials', title: '列出公开授信材料', description: '列出公开材料', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'credit_public_search', title: '检索公开授信材料', description: '检索材料片段', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
] } };

test('通用 AI 侧栏接替授信助手并可选择公开材料工具', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await page.route('**/mcp', route => route.fulfill({ json: toolCatalog }));
  await page.goto('/credit-workbench');
  await expect(page.getByRole('link', { name: '授信助手' })).toHaveCount(0);
  await page.getByRole('button', { name: '打开 AI 面板' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await panel.getByRole('button', { name: '工具设置' }).click();
  await expect(panel.getByText('检索公开授信材料')).toBeVisible();
  await expect(panel.getByText('列出公开授信材料')).toBeVisible();
  await expect(panel).toHaveScreenshot('agent-credit-tools.png');
});

test('本地授信对话刷新后恢复且保留来源文本', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await page.route('**/mcp', route => route.fulfill({ json: toolCatalog }));
  await page.addInitScript(() => localStorage.setItem('eastmoney-browser-agent:visual-test', JSON.stringify({
    selectedId: 'credit-history', conversations: [{
      id: 'credit-history', title: '授信材料查询', createdAt: 1,
      messages: [{ role: 'user', text: '查询授信公开材料' }, { role: 'assistant', text: '公开材料显示 2026 年半年度报告。来源：测试公司2026年半年度报告（AI Search 检索片段）。' }],
      modelMessages: [{ role: 'user', content: '查询授信公开材料' }, { role: 'assistant', content: '公开材料显示 2026 年半年度报告。' }],
    }],
  })));
  await page.goto('/credit-workbench');
  await page.getByRole('button', { name: '打开 AI 面板' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await expect(panel.getByText('AI Search 检索片段', { exact: false })).toBeVisible();
  await expect(panel).toHaveScreenshot('agent-credit-history.png');
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 面板' }).click();
  await expect(page.getByText('AI Search 检索片段', { exact: false })).toBeVisible();
});

function modelEnvelope(id, output, status = 'completed') {
  return { id, object: 'response', created_at: 1, status, model: 'gpt-6-luna', output,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    error: null, incomplete_details: null, parallel_tool_calls: false, tools: [] };
}
function modelSse(events) { return events.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n'; }
function modelToolCall() {
  const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'credit_public_search', arguments: '{"query":"授信"}', status: 'completed' };
  return modelSse([
    { type: 'response.created', response: modelEnvelope('r_1', [], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: modelEnvelope('r_1', [item]) },
  ]);
}
function modelAnswer(text) {
  const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return modelSse([
    { type: 'response.created', response: modelEnvelope('r_2', [], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: modelEnvelope('r_2', [item]) },
  ]);
}

test('浏览器 agent 完成授信检索工具循环并展示原件链接', async ({ page }) => {
  await mockResources(page);
  const tool = toolCatalog.result.tools[1];
  let toolCalls = 0, modelCalls = 0;
  await page.route('**/mcp', route => {
    const rpc = route.request().postDataJSON();
    if (rpc.method === 'tools/list') return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { tools: [tool] } } });
    toolCalls++;
    expect(rpc.params.name).toBe('credit_public_search');
    return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { sources: [
      { title: '公开报告', text: '授信余额为 10 亿元', url: '/api/credit-assistant/files/%E5%85%AC%E5%BC%80%E6%8A%A5%E5%91%8A.pdf', locator: 'AI Search 检索片段' },
    ] } } } });
  });
  await page.route('**/api/ai/responses', route => {
    modelCalls++;
    const body = route.request().postDataJSON();
    expect(body.model).toBe('gpt-6-luna');
    if (modelCalls === 2) expect(body.input.some(item => item.type === 'function_call_output')).toBe(true);
    return route.fulfill({ contentType: 'text/event-stream', body: modelCalls === 1 ? modelToolCall() : modelAnswer('依据公开报告，授信余额为 10 亿元。') });
  });
  await page.goto('/credit-workbench');
  await page.getByRole('button', { name: '打开 AI 面板' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await panel.getByRole('textbox', { name: '输入消息' }).fill('查询授信');
  await panel.getByRole('button', { name: '发送消息' }).click();
  await expect(panel.getByText('依据公开报告，授信余额为 10 亿元。')).toBeVisible();
  await expect(panel.getByRole('link', { name: '公开报告' })).toHaveAttribute('href', '/api/credit-assistant/files/%E5%85%AC%E5%BC%80%E6%8A%A5%E5%91%8A.pdf');
  expect(modelCalls).toBe(2);
  expect(toolCalls).toBe(1);
});
