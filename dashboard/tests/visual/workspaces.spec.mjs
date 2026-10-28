import { test, expect } from '@playwright/test';
import { mockResources, workflow } from './fixtures.mjs';
import { VERTICAL_GAP } from '../../src/lib/trading-workflow/graph.ts';

let errors, requests;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  requests = await mockResources(page);
});
test.afterEach(() => {
  expect(errors, 'browser runtime errors').toEqual([]);
  expect(requests, 'unregistered network requests').toEqual([]);
});

async function screenshot(page, name) {
  if (name !== 'credit-error') await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const target = name === 'home' ? page : name === 'market-report'
    ? page.locator('#visual-report-panel') : page.locator('.tr-workspace');
  await expect(target).toHaveScreenshot(`${name}.png`);
}

const scenes = [
  ['home', '/', '资金日报'],
  ['overview', '/trading-research', '资金存量指标'],
  ['trading', '/trading-research/trading', '实时交易记录'],
  ['workflow', '/trading-research/workflow', '编辑模式'],
  ['credit', '/credit-workbench', '授信额度（按类型）'],
  ['credit-ledger', '/credit-workbench/ledger', '银行甲'],
  ['calendar', '/credit-workbench/calendar', '授信新增 · 15亿元'],
  ['credit-weekly', '/credit-workbench/weekly', '银行甲'],
  ['research', '/trading-research/research', '宏观指标'],
  ['secondary', '/trading-research/secondary-bond-pool', '测试国债'],
  ['market-report', '/market-briefing', '权益市场'],
  ['schedule', '/financing/schedule', '启动时点'],
];
for (const [name, path, ready] of scenes) {
  test(`${name} renders`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await screenshot(page, name);
  });
}

test('portal exposes real destinations', async ({ page }) => {
  await page.goto('/');
  for (const [name, href] of [
    ['今日资金日报', '/fund-report/2026-09-15.html'], ['历史资金日报', '/fund-report'],
    ['市场点评', '/market-briefing'], ['融资工作台', '/financing/'],
    ['交易研究工作台', '/trading-research'], ['授信工作台', '/credit-workbench'], ['管理', '/management'],
  ]) await expect(page.getByRole('link', { name: new RegExp(`^${name}( |$)`) })).toHaveAttribute('href', href);
  await page.getByRole('link', { name: /^交易研究工作台/ }).click();
  await expect(page.getByText('资金存量指标', { exact: true })).toBeVisible();
});

test('desktop trading keeps the status column visible while filtering and sorting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop table layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/trading-research/trading');
  await page.getByRole('combobox', { name: '交易状态', exact: true }).selectOption('待确认');
  await page.getByRole('combobox', { name: '交易排序', exact: true }).selectOption('amount-desc');
  const table = page.getByRole('table', { name: '交易研究工作台交易记录' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody tr').first()).toContainText('农业银行');
  const region = page.getByRole('region', { name: '交易记录', exact: true });
  const rightEdge = (await region.boundingBox()).x + (await region.boundingBox()).width;
  const status = await table.getByRole('columnheader', { name: '状态', exact: true }).boundingBox();
  expect(status.x + status.width).toBeLessThanOrEqual(rightEdge + 1);
});

test('trading management tabs switch between records and workflow', async ({ page }) => {
  await page.goto('/trading-research/trading');
  const tabs = page.getByRole('navigation', { name: '标签页' });
  const records = tabs.getByRole('link', { name: '交易记录' });
  const workflowTab = tabs.getByRole('link', { name: '交易流程' });
  const tradingNav = page.locator('#tr-workbench-drawer a[href="/trading-research/trading"]');

  await expect(records).toHaveAttribute('aria-current', 'page');
  await workflowTab.click();
  await expect(page).toHaveURL('/trading-research/workflow');
  await expect(workflowTab).toHaveAttribute('aria-current', 'page');
  await expect(tradingNav).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('checkbox', { name: '编辑模式' })).toBeVisible();

  await records.click();
  await expect(page).toHaveURL('/trading-research/trading');
  await expect(records).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: '交易记录', exact: true })).toBeVisible();
});

test('workflow expands a branch and opens the real editor', async ({ page }) => {
  await page.goto('/trading-research/workflow');
  const collapse = page.getByRole('button', { name: '折叠拆借', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('complementary', { name: '流程展开与折叠' }).getByRole('button')).toHaveCount(3);
  await page.getByRole('button', { name: '展开交易所回购', exact: true }).click();
  await expect(page.locator('[data-workflow-node="exchange-o32"]')).toBeVisible();
  // The transfer title wraps after the lane opens. Wait for ResizeObserver's
  // measured height to reach the graph before capturing downstream nodes.
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => {
    const transfer = document.querySelector('[data-workflow-node="exchange-transfer"]').getBoundingClientRect();
    const sign = document.querySelector('[data-workflow-node="exchange-sign"]').getBoundingClientRect();
    return Math.round(sign.top - transfer.top) - Math.round(transfer.height);
  })).toBe(VERTICAL_GAP);
  await screenshot(page, 'workflow-expanded');
  await page.getByRole('checkbox', { name: '编辑模式' }).check();
  await page.locator('[data-workflow-node="shared-elements"] .node-surface').click();
  await expect(page.locator('.workflow-editor')).toBeVisible();
  await screenshot(page, 'workflow-editor');
});

test('workflow branches expand to the right without displacing the main path', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/trading-research/workflow');
  const trigger = page.locator('[data-workflow-node="reverse-change"]');
  const next = page.locator('[data-workflow-node="reverse-counterparty"]');
  await expect(trigger).toBeVisible();
  const before = await next.evaluate(element => element.closest('.svelte-flow__node').style.transform);
  await trigger.locator('.node-surface').click();
  const child = page.locator('[data-workflow-node="reverse-position"]');
  await expect(child).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const rect = id => document.querySelector(`[data-workflow-node="${id}"]`).getBoundingClientRect();
    const a = rect('reverse-change'), b = rect('reverse-position');
    return b.left - a.right;
  })).toBeGreaterThan(0);
  const after = await next.evaluate(element => element.closest('.svelte-flow__node').style.transform);
  expect(after.split(',')[1]).toBe(before.split(',')[1]);
  await screenshot(page, 'workflow-branch');
});

test('workflow main connectors use bottom centers and branch rails animate in both directions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/trading-research/workflow');
  const trigger = page.locator('[data-workflow-node="reverse-change"] .node-surface');
  await expect(trigger).toBeVisible();
  await expect(page.locator('path[id="loan-send:loan-deal"]')).toBeAttached();
  const anchor = await page.evaluate(() => {
    const node = document.querySelector('[data-workflow-node="loan-send"]').getBoundingClientRect();
    const path = document.querySelector('path[id="loan-send:loan-deal"]');
    const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
    return { dx: Math.abs(point.x - (node.left + node.width / 2)), dy: Math.abs(point.y - node.bottom) };
  });
  expect(anchor.dx).toBeLessThan(4);
  expect(anchor.dy).toBeLessThan(4);
  async function sampleToggle() {
    return page.evaluate(async () => {
      document.querySelector('[data-workflow-node="reverse-change"] .node-surface').click();
      const samples = [];
      const start = performance.now();
      while (performance.now() - start < 360) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const node = document.querySelector('[data-workflow-node="reverse-position"]')?.closest('.svelte-flow__node');
        const frame = document.querySelector('[data-workflow-branch="reverse-change"]');
        if (node && frame) samples.push({ opacity: Number(getComputedStyle(node).opacity), x: node.getBoundingClientRect().x,
          frameOpacity: Number(getComputedStyle(frame).opacity) });
      }
      return samples;
    });
  }
  const opening = await sampleToggle();
  expect(opening.some(sample => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
  expect(opening.some(sample => sample.frameOpacity > 0 && sample.frameOpacity < 1)).toBe(true);
  expect(new Set(opening.map(sample => Math.round(sample.x))).size).toBeGreaterThan(1);
  await expect(page.locator('[data-workflow-branch="reverse-change"]')).toBeVisible();
  const closing = await sampleToggle();
  expect(closing.some(sample => sample.opacity > 0 && sample.opacity < 1)).toBe(true);
  await expect(page.locator('[data-workflow-node="reverse-position"]')).toHaveCount(0);
  await expect(page.locator('[data-workflow-branch="reverse-change"]')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(page.locator('[data-workflow-node="reverse-position"]').locator('..')).toHaveCSS('opacity', '1');
});

test('credit failure is visible instead of an empty success', async ({ page }) => {
  await page.unrouteAll();
  requests = await mockResources(page, { creditError: true });
  await page.goto('/credit-workbench');
  await expect(page.getByText(/暂不可用|失败/).first()).toBeVisible();
  await screenshot(page, 'credit-error');
});

test('schedule switches modes and resets without stale fields', async ({ page }, testInfo) => {
  await page.goto('/financing/schedule');
  // The synthetic route must also load its wrapper's shipping component CSS.
  await expect(page.locator('.module-card')).toHaveCSS('padding-left', testInfo.project.name === 'mobile' ? '15px' : '18px');
  await page.getByRole('combobox', { name: '节点时间配置' }).selectOption('point');
  await expect(page.getByRole('spinbutton', { name: '节点启动偏移天数' })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: '节点计划偏移天数' }).fill('2');
  await expect(page.getByRole('status')).toContainText('T+2');
  await screenshot(page, 'schedule-point');
  await page.getByRole('button', { name: '重置' }).click();
  await expect(page.getByRole('spinbutton', { name: '节点启动偏移天数' })).toHaveValue('-5');
  await expect(page.getByRole('status')).toContainText('T-5 至 T-1');
});

test('secondary pool empty state is a successful empty report', async ({ page }) => {
  await page.unrouteAll();
  requests = await mockResources(page, { ledgerEmpty: true });
  await page.goto('/trading-research/secondary-bond-pool');
  await expect(page.getByRole('heading', { name: '所选范围暂无二级池数据' })).toBeVisible();
  await expect(page.getByRole('button', { name: /更新中/ })).toHaveCount(0);
  await screenshot(page, 'secondary-empty');
});


test('workflow successor edits save and reload without duplicating a shared node', async ({ page }) => {
  let stored = structuredClone(workflow);
  await page.route('**/api/trading-workflow/config', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.expectedVersion).toBe(stored.version);
      expect(body.flows.map(flow => flow.id)).toEqual(['loan', 'reverse', 'exchange']);
      stored = { ...stored, nodes: body.nodes, flows: body.flows, version: stored.version + 1 };
      return route.fulfill({ json: { version: stored.version, flows: stored.flows, nodes: stored.nodes } });
    }
    return route.fulfill({ json: stored });
  });
  await page.goto('/trading-research/workflow');
  await page.getByRole('checkbox', { name: '编辑模式' }).check();
  await page.locator('[data-workflow-node="loan-deal"] .node-surface').click();
  await page.getByRole('button', { name: '上移', exact: true }).click();
  await expect(page.getByLabel('后续节点 1', { exact: true })).toHaveValue('loan-send');
  // A second successor turns the existing reverse node into a single merge target.
  await page.getByLabel('添加后续节点', { exact: true }).selectOption('reverse-change');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.workflow-editor')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('path[id="loan-deal:loan-send"]')).toBeAttached();
  await expect(page.locator('path[id="loan-deal:reverse-change"]')).toBeAttached();
  await expect(page.locator('[data-workflow-node="reverse-change"]')).toHaveCount(1);
  await expect(page.locator('[data-workflow-node="reverse-change"]')).toHaveAttribute('data-scope', 'shared');
  expect(stored.nodes.every(node => !('scope' in node))).toBe(true);
});
