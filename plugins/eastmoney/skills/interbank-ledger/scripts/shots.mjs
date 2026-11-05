// 复用登录 cookie，用 Playwright 打开资金系统页面逐笔截图并归档。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ORIGIN, shanghaiToday } from './camel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadPlaywright() {
  const roots = [here, process.cwd(), path.join(os.homedir(), '.cache/eastmoney-interbank')];
  for (const name of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) {
    for (const root of roots) { try { return await import(pathToFileURL(createRequire(path.join(root, 'x.js')).resolve(name)).href); } catch {} }
  }
  try { return await import('playwright'); } catch {}
  throw new Error('找不到 playwright：运行 `npm i --prefix ~/.cache/eastmoney-interbank playwright && npx --prefix ~/.cache/eastmoney-interbank playwright install chromium`，或用 PLAYWRIGHT_MODULE 指向已有安装');
}

async function openPage(context, route, ready) {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.el-menu', { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // 首次加载时水印里的用户信息尚未写入 localStorage，重载一次让截图水印完整。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page).waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  return page;
}

async function filterDate(page, from, to = from) {
  const start = page.getByPlaceholder('开始日期').first(), end = page.getByPlaceholder('结束日期').first();
  await start.click(); await start.fill(from);
  await end.click(); await end.fill(to); await end.press('Enter');
  await page.getByRole('button', { name: '查询', exact: true }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  if (await page.locator('.el-overlay-dialog:visible').count()) {
    await page.locator('.el-dialog:visible .el-dialog__headerbtn').first().click();
    await page.waitForTimeout(500);
  }
}

/**
 * trades: [{serialNo, hid}]。输出到 outDir：
 *   同业拆入台账.png、<IBO> 划拨申请.png、我的提交.png、<IBO> 审批流程.png
 * 返回 {files, missing}，missing 为未能截到图的条目。
 */
export async function captureFlows({ token, date, trades, outDir, headed = false, log = console.error }) {
  const { chromium } = await loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const files = [], missing = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1900 } });
    await context.addCookies([{ name: 'dchktoken', value: token, domain: new URL(ORIGIN).hostname, path: '/' }]);
    const save = async (page, name) => { const file = path.join(outDir, name); await page.screenshot({ path: file }); files.push(file); log(`截图 ${name}`); };

    const ledger = await openPage(context, '/flowManagement/debtManagement/creditBusiness/sameIn', page => page.locator('.el-table').first());
    await filterDate(ledger, date);
    await save(ledger, '同业拆入台账.png');
    const order = (await ledger.locator('.el-table__body-wrapper .el-table__body tr').allInnerTexts()).map(text => text.match(/IBO\d{14}/)?.[0]);
    for (const trade of trades) {
      try {
        const index = order.indexOf(trade.serialNo);
        if (index < 0) throw new Error('台账页未找到该笔');
        const fixed = ledger.locator('.el-table__fixed-right .el-table__body tr');
        const button = (await fixed.count()) ? fixed.nth(index).getByText('查看申请') : ledger.locator('.el-table__body tr').nth(index).getByText('查看申请').first();
        await button.click();
        await ledger.locator('.el-dialog:visible').getByText('划拨单号').waitFor({ timeout: 15000 });
        await ledger.waitForLoadState('networkidle').catch(() => {});
        await ledger.waitForTimeout(800);
        await save(ledger, `${trade.serialNo} 划拨申请.png`);
        await closeDialog(ledger);
      } catch (error) { missing.push({ serialNo: trade.serialNo, step: '划拨申请', error: error.message }); await closeDialog(ledger).catch(() => {}); }
    }

    await ledger.close();
    const flows = await openPage(context, '/processManagement/submitedEvents/index', page => page.getByRole('button', { name: '查看流程' }));
    await flows.setViewportSize({ width: 1440, height: 1400 });
    await filterDate(flows, shanghaiToday());
    await save(flows, '我的提交.png');
    for (const trade of trades) {
      try {
        if (!trade.hid) throw new Error('没有划拨单号');
        await flows.getByText(String(trade.hid), { exact: true }).first().click({ timeout: 10000 });
        await flows.getByRole('button', { name: '查看流程' }).click();
        await flows.locator('.el-dialog:visible').getByText('处理人').first().waitFor({ timeout: 15000 });
        await flows.waitForTimeout(1200);
        await save(flows, `${trade.serialNo} 审批流程.png`);
        await closeDialog(flows);
      } catch (error) { missing.push({ serialNo: trade.serialNo, step: '审批流程', error: error.message }); await closeDialog(flows).catch(() => {}); }
    }
  } finally { await browser.close(); }
  return { files, missing };
}
