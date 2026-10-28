import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';
import { creditFull } from './audit-fixtures.mjs';
import { creditDataFixture } from '../helpers/credit-data-fixture.mjs';

async function prepare(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const unregistered = await mockResources(page);
  const report = structuredClone(creditFull);
  report.institutions[0].institutionType = '国有银行';
  report.institutions[1].institutionType = '股份行';
  report.institutions[1].status = 'applying';
  report.institutions[1].expiryDate = '2026-09-01';
  report.institutions.push({ ...structuredClone(report.institutions[0]), institutionName: '模拟撤销行', expiryDate: '1970-01-01', status: 'revoked' });
  await page.route('**/api/credit**', route => {
    const date = new URL(route.request().url()).searchParams.get('date') ?? report.summary.reportDate;
    const current = { ...report, summary: { ...report.summary, reportDate: date }, institutions: report.institutions.map(row => ({ ...row, reportDate: date })) };
    return route.fulfill({ json: creditDataFixture(current) });
  });
  await page.goto('/credit-workbench/ledger');
  await expect(page.getByRole('button', { name: '导出Excel', exact: true })).toBeEnabled();
  return { errors, unregistered, report };
}

test('credit Excel export downloads the complete report snapshot while filtered and changing date', async ({ page }, testInfo) => {
  const { errors, unregistered, report } = await prepare(page);
  await page.getByRole('searchbox', { name: '搜索授信机构' }).fill('银行甲');
  await page.getByRole('combobox', { name: '授信风险', exact: true }).selectOption('warning');
  await page.getByRole('button', { name: '清除排序', exact: true }).click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/exceljs[^/]*\.js/, async route => { await gate; await route.continue(); });
  const apiRequests = [];
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出Excel', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出中…', exact: true })).toBeDisabled();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-export-loading.png');
  await page.getByRole('button', { name: `报告日：${report.summary.reportDate}`, exact: true }).click();
  await page.getByRole('dialog', { name: '选择报告日', exact: true }).getByRole('button', { name: '26Q3', exact: true }).click();
  await expect(page.getByRole('button', { name: '报告日：2026-09-30', exact: true })).toBeVisible();
  const requestCount = apiRequests.length;
  release();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('证券公司授信一览表-2026.09.15.xlsx');
  const output = testInfo.outputPath('credit-export.xlsx');
  await download.saveAs(output);
  const workbook = XLSX.read(await readFile(output), { type: 'buffer', cellDates: true });
  expect(workbook.SheetNames).toEqual(['授信一览表']);
  const sheet = workbook.Sheets['授信一览表'];
  expect([sheet.C4.v, sheet.C5.v]).toEqual(['银行甲', '银行乙']);
  expect(sheet.C6).toBeUndefined(); // total; revoked excluded
  expect(sheet.F5.v).toBe(1);
  expect(sheet.AB4.v.toISOString().slice(0, 10)).toBe(report.institutions[0].expiryDate);
  expect(apiRequests).toHaveLength(requestCount); // generation has no business request
  await expect(page.getByRole('button', { name: '导出Excel', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
  expect(unregistered).toEqual([]);
});

test('credit Excel export shows global feedback for generation failure and empty reports', async ({ page }) => {
  await prepare(page);
  await page.route(/exceljs[^/]*\.js/, route => route.abort());
  await page.getByRole('button', { name: '导出Excel', exact: true }).click();
  await expect(page.getByText('Excel导出失败，请重试', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出Excel', exact: true })).toBeEnabled();
  await page.route('**/api/credit**', route => route.fulfill({ json: creditDataFixture({ ...structuredClone(creditFull), institutions: [], recentApprovals: [], weeklyNews: [] }) }));
  await page.reload();
  await expect(page.getByRole('button', { name: '导出Excel', exact: true })).toBeEnabled();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-export-empty.png');
  await page.getByRole('button', { name: '导出Excel', exact: true }).click();
  await expect(page.getByText('暂无可导出的授信机构', { exact: true })).toBeVisible();
});

test('credit weekly exports one complete PNG after scrolling through the detail table', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const unregistered = await mockResources(page);
  const report = structuredClone(creditFull);
  report.institutions = Array.from({ length: 30 }, (_, index) => ({
    ...structuredClone(creditFull.institutions[0]),
    institutionName: `银行${String(index + 1).padStart(2, '0')}`,
  }));
  await page.route('**/api/credit**', route => route.fulfill({ json: creditDataFixture(report) }));
  await page.goto('/credit-workbench/weekly');
  const surface = page.locator('.tr-credit-weekly-report');
  await expect(surface.getByRole('rowheader', { name: '银行30', exact: true })).toHaveCount(1);
  await surface.getByRole('rowheader', { name: '银行30', exact: true }).scrollIntoViewIfNeeded();
  const scrollTop = await page.locator('.tr-workspace').evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/export-[^/]+\.js/, async route => { await gate; await route.continue(); });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出图片', exact: true }).click();
  await expect(page.getByRole('button', { name: `报告日：${report.summary.reportDate}`, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出中…', exact: true })).toBeDisabled();
  release();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`资金管理部-授信周报-${report.summary.reportDate}.png`);
  const output = testInfo.outputPath('credit-weekly.png');
  await download.saveAs(output);
  const bytes = await readFile(output);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(height).toBeGreaterThan(3 * 900);
  await expect(page.getByRole('button', { name: '导出图片', exact: true })).toBeEnabled();
  expect(await page.locator('.tr-workspace').evaluate(element => element.scrollTop)).toBe(scrollTop);
  await expect(surface).not.toHaveClass(/is-export-capture/);
  expect(errors).toEqual([]);
  expect(unregistered).toEqual([]);
  const preview = await page.context().newPage();
  await preview.setContent(`<img alt="授信周报导出图片" src="data:image/png;base64,${bytes.toString('base64')}" style="display:block;width:${width / 3}px">`);
  await expect(preview.getByRole('img')).toHaveScreenshot('credit-weekly-export-image.png');
  await preview.close();
});
