import { test, expect } from '@playwright/test';
import { mockResources, marketSnapshot } from './fixtures.mjs';

async function closeAiSurfaces(page) {
  const closePanel = page.getByRole('button', { name: '关闭 AI 面板' });
  if (await closePanel.isVisible()) {
    await closePanel.click();
    await expect(page.getByRole('complementary', { name: 'AI 助手' })).not.toBeVisible();
  }
  const notifications = page.getByRole('button', { name: '关闭通知' });
  while (await notifications.count()) {
    const count = await notifications.count();
    await notifications.first().click();
    await expect(notifications).toHaveCount(count - 1);
  }
}

test('报告只读取归档，控件的选择悬浮按下及焦点状态可辨识', async ({ page, isMobile }) => {
  const unexpected = await mockResources(page);
  const requests=[];
  page.on('request',request=>{if(/\/(api|data)\//.test(request.url()))requests.push(request);});
  await page.goto('/market-briefing');
  const visual=page.getByRole('link',{name:'可视化',exact:true});
  const text=page.getByRole('link',{name:'文字版',exact:true});
  await expect(page.getByRole('heading',{name:'今日聚焦'})).toBeVisible();
  await expect(visual).toHaveAttribute('aria-current','page');
  await expect(page.getByRole('button',{name:'重新生成今日聚焦'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'输入今日聚焦'})).toBeEditable();
  expect(requests.map(request=>new URL(request.url()).pathname)).toEqual(['/api/market-report']);
  expect(requests.every(request=>request.method()==='GET')).toBe(true);
  const tabStyle=button=>button.evaluate(el=>{
    const style=getComputedStyle(el);
    return {background:style.backgroundColor,underline:style.borderBottomColor};
  });
  expect((await tabStyle(visual)).underline).not.toBe((await tabStyle(text)).underline);
  if (!isMobile) {
    const before=(await tabStyle(text)).background;
    await text.hover();
    await expect.poll(async()=>(await tabStyle(text)).background).not.toBe(before);
    await page.mouse.down();
    expect(await text.evaluate(el=>getComputedStyle(el).filter)).not.toBe('none');
    await page.mouse.up();
  } else await text.click();
  await expect(text).toHaveAttribute('aria-current','page');
  await expect(page.locator('.text-report__editor')).toHaveAttribute('contenteditable','false');
  await visual.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await visual.evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
  expect(unexpected).toEqual([]);
});

test('未归档报告明确报错，重新尝试仍只读取归档', async ({ page }) => {
  const unexpected=await mockResources(page);
  const calls=[];
  await page.route('**/api/market-report*',route=>{calls.push(route.request().url());return route.fulfill({status:404,json:{detail:'2026-09-15 尚无市场点评定稿',error:{code:'REPORT_NOT_FINALIZED'}}});});
  await page.goto('/market-briefing?date=2026-09-15');
  await expect(page.getByRole('alert')).toContainText('尚无市场点评定稿');
  await expect(page.getByRole('button',{name:'导出图片'})).toBeDisabled();
  await page.getByRole('button',{name:'重新尝试'}).click();
  await expect.poll(()=>calls.length).toBe(2);
  expect(unexpected).toEqual([]);
});


test('市场点评标签链接可直达并保留日期和浏览器历史', async ({ page }) => {
  await mockResources(page);
  await page.goto('/market-briefing/text?date=2026-09-15');
  const tabs = page.getByRole('navigation', { name: '标签页' });
  await expect(tabs.getByRole('link', { name: '文字版', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.text-report__editor')).toBeVisible();
  await tabs.getByRole('link', { name: '可视化', exact: true }).click();
  await expect(page).toHaveURL(/market-briefing\?date=2026-09-15$/);
  await page.goBack();
  await expect(page.locator('.text-report__editor')).toBeVisible();
  await page.reload();
  await expect(tabs.getByRole('link', { name: '文字版', exact: true })).toHaveAttribute('aria-current', 'page');
});


test('聚焦直接编辑、生成失败保留原稿，重新生成后跨标签保留修改', async ({ page }) => {
  const unexpected = await mockResources(page);
  let fail = true;
  await page.route('**/api/market-briefing?*', route => route.fulfill(fail
    ? { status: 503, json: { error: '生成暂不可用' } }
    : { contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify({ report_date: marketSnapshot.report_date, stock: '重新生成的股票点评', bond: '重新生成的债券点评', news_count: 2 })}\n\n` }));
  await page.goto('/market-briefing');
  const editor = page.getByRole('textbox', { name: '输入今日聚焦' });
  await editor.fill('1、人工修订股票点评。\n2、人工修订债券点评。');
  await page.getByRole('button', { name: '重新生成今日聚焦' }).click();
  await expect(page.getByRole('button', { name: '重新生成今日聚焦' })).toBeEnabled();
  await expect(editor).toContainText('人工修订股票点评');
  await closeAiSurfaces(page);
  fail = false;
  await page.getByRole('button', { name: '重新生成今日聚焦' }).click();
  await expect(editor).toContainText('重新生成的股票点评');
  await closeAiSurfaces(page);
  await editor.fill('1、生成后继续修改。\n2、债券点评。');
  await page.getByRole('link', { name: '文字版', exact: true }).click();
  await expect(page.locator('.text-report__editor')).toContainText('生成后继续修改');
  await page.getByRole('link', { name: '可视化', exact: true }).click();
  await expect(editor).toContainText('生成后继续修改');
  expect(unexpected).toEqual([]);
});

test('AI 生成自动展开任务详情、轮替模型摘要并保留完成结果', async ({ page }) => {
  const unexpected = await mockResources(page);
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/market-briefing?')) return nativeFetch(input, init);
      const reportDate = new URL(url, window.location.href).searchParams.get('date');
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('event: progress\ndata: 正在读取市场材料\n\n'));
        controller.enqueue(encoder.encode('event: progress\ndata: 正在核对股债市场驱动\n\n'));
        window.__finishAiPanelVisual = () => {
          controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({ report_date: reportDate, stock: '股票结论', bond: '债券结论', news_count: 2 })}\n\n`));
          controller.close();
        };
      } });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    };
  });
  await page.goto('/market-briefing');
  await page.getByRole('button', { name: '重新生成今日聚焦' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await expect(panel).toBeVisible();
  const liveProgress = panel.getByRole('status');
  await expect(liveProgress.getByText('正在核对股债市场驱动', { exact: true })).toBeVisible();
  await expect(liveProgress).not.toContainText('正在读取市场材料');
  await expect(panel).toHaveScreenshot('ai-panel-progress.png');
  await page.evaluate(() => window.__finishAiPanelVisual());
  await expect(panel.getByRole('heading', { name: '结果' })).toBeVisible();
  await expect(panel).toContainText('股票结论');
  await expect(page.getByText('生成完成', { exact: true })).toBeVisible();
  await expect(panel).toHaveScreenshot('ai-panel-complete.png');
  expect(unexpected).toEqual([]);
});

test('AI 对话侧栏挤压桌面页面并提供会话与工具设置', async ({ page, isMobile }) => {
  await mockResources(page);
  await page.route('**/mcp', route => route.fulfill({ json: { jsonrpc: '2.0', id: 'visual', result: { tools: [
    { name: 'credit_report', title: '读取授信报表', description: '读取授信报表', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'update_credit_institution', title: '修改授信机构', description: '修改授信机构', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
  ] } } }));
  await page.goto('/market-briefing');
  const content = page.locator('.site-content');
  const before = await content.boundingBox();
  await page.getByRole('button', { name: '打开 AI 面板' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await expect(panel.getByRole('heading', { name: '你好。' })).toBeVisible();
  if (!isMobile) {
    await expect.poll(async () => (await content.boundingBox()).width).toBeLessThan(before.width - 300);
    const after = await content.boundingBox();
    await panel.getByRole('button', { name: '展开宽面板' }).click();
    await expect.poll(async () => (await content.boundingBox()).width).toBeLessThan(after.width - 200);
    await panel.getByRole('button', { name: '收起宽面板' }).click();
  }
  await expect(panel).toHaveScreenshot('ai-agent-welcome.png');
  await panel.getByRole('button', { name: '工具设置' }).click();
  await expect(panel.getByRole('checkbox')).toHaveCount(3);
  await panel.getByRole('button', { name: '切换运行模式' }).click();
  await expect(panel.getByRole('button', { name: '切换运行模式' })).toContainText('Act');
  await panel.getByRole('button', { name: '新对话', exact: true }).click();
  await panel.getByRole('button', { name: '关闭 AI 面板' }).click();
  await expect(panel).not.toBeVisible();
});

test('导出并发下载图片与归档，保存失败保留编辑且可重试', async ({ page }) => {
  const unexpected = await mockResources(page);
  let releaseSave;
  let savedBody;
  let fail = true;
  let snapshot = structuredClone(marketSnapshot);
  await page.route('**/api/market-report*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    savedBody = route.request().postDataJSON();
    await new Promise(resolve => { releaseSave = resolve; });
    if (fail) return route.fulfill({ status: 503, json: { error: '归档暂不可用' } });
    snapshot = { ...savedBody.report, focus_text: savedBody.focusText, cached_at: '2026-09-15T10:30:00Z', finalized_at: '2026-09-15T10:30:00Z' };
    return route.fulfill({ json: snapshot });
  });
  await page.goto('/market-briefing');
  const editor = page.getByRole('textbox', { name: '输入今日聚焦' });
  await editor.fill('1、导出的人工点评。\n2、债券点评。');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出图片', exact: true }).click();
  await expect.poll(() => savedBody?.focusText).toContain('导出的人工点评');
  expect(savedBody.report.report_date).toBe(marketSnapshot.report_date);
  // Download must finish while the R2 response is still blocked.
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  await expect(page.getByLabel('选择报告日期', { exact: true })).toBeDisabled();
  releaseSave();
  await expect(page.getByRole('button', { name: '导出图片', exact: true })).toBeEnabled();
  await expect(editor).toContainText('导出的人工点评');
  await page.getByRole('button', { name: '关闭通知' }).click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  fail = false;
  releaseSave = undefined;
  const retryDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出图片', exact: true }).click();
  await expect.poll(() => typeof releaseSave).toBe('function');
  releaseSave();
  await retryDownload;
  await expect(page.getByRole('button', { name: '导出图片', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭通知' }).click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(editor).toContainText('导出的人工点评');
  expect(unexpected).toEqual([]);
});

test('市场点评页头操作、日期和个人入口尺寸一致', async ({ page }) => {
  await mockResources(page);
  await page.goto('/market-briefing');
  await expect(page.getByRole('heading', { name: '今日聚焦' })).toBeVisible();
  const heights = await page.locator('.page-header__meta [data-slot="button"], .page-header__meta .hero-date').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThanOrEqual(4);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
});
