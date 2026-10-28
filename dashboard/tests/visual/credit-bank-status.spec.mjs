import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';
import { creditFull } from './audit-fixtures.mjs';
import { creditDataFixture } from '../helpers/credit-data-fixture.mjs';

async function setup(page) {
  await mockResources(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/credit**', route => {
    const date = new URL(route.request().url()).searchParams.get('date') || '2026-06-30';
    const report = structuredClone(creditFull);
    report.summary.reportDate = date;
    report.previousDate = null;
    report.availableDates = ['2026-06-30', '2026-09-30'];
    report.weeklyNews = report.recentApprovals = [];
    const institutions = [
      ['兴业银行', '股份行', 460, 210.3], ['信银理财', '股份行', 330, 35],
      ['浦发银行', '股份行', 177, 82.5], ['招商银行', '股份行', 160, 95.6],
      ['建设银行', '国有银行', 137, 36.17], ['邮储银行', '国有行', 130, 57.9],
      ['招银理财', '股份行', 125, 55.92], ['农业银行上海分行（授信经办机构）', '国有行', 120, 67.6],
      ['建信理财', '国有行', 101.25, 22.1], ['民生银行', '股份行', 80, 33.6],
      ['政策银行', '政策性银行', 30, 7], ['城市商业银行', '城商行', 20, 2],
      ['农村商业银行', '农商行', 10, 1], ['外资银行', '外资行', 26, 0],
    ];
    report.institutions = institutions.map(([institutionName, institutionType, totalLimit, totalUsed], index) => ({
      ...structuredClone(creditFull.institutions[0]), institutionName, institutionType,
      reportDate: date, expiryDate: '2027-12-31', totalLimit: totalLimit + (date === '2026-09-30' && index === 0 ? 10 : 0), totalUsed,
      items: [{ type: 'other', limitAmount: null, usedAmount: totalUsed, details: null }],
      clients: [{ id: String(index), name: institutionName }],
    }));
    return route.fulfill({ json: creditDataFixture(report) });
  });
  return errors;
}

test('bank credit table follows report date and preserves overview navigation', async ({ page }, testInfo) => {
  const errors = await setup(page);
  await page.goto('/credit-workbench?tab=bank-credit&date=2026-06-30');
  await expect(page.getByRole('link', { name: '银行授信情况', exact: true })).toHaveAttribute('aria-current', 'page');
  const summary = page.getByRole('table', { name: '银行性质汇总', exact: true });
  const top = page.getByRole('table', { name: '前十大授信机构明细', exact: true });
  await expect(summary.getByRole('rowheader', { name: '合计', exact: true })).toBeVisible();
  await expect(summary.getByRole('row', { name: /^城、农商行/ })).toContainText('30.00');
  await expect(top.locator('tbody tr')).toHaveCount(10);
  await expect(top.locator('tbody tr').first()).toHaveText('兴业银行460.00210.30249.70');
  await expect(page.getByText('数据时点：2026-06-30', { exact: true })).toBeVisible();
  await expect(page.locator('.page-header')).toHaveScreenshot('credit-bank-header.png');
  await expect(page.locator('section[aria-labelledby="bank-credit-summary-title"]')).toHaveScreenshot('credit-bank-summary.png');
  await top.scrollIntoViewIfNeeded();
  const topCard = page.locator('section[aria-labelledby="bank-credit-top-title"]');
  if (testInfo.project.name === 'mobile') await topCard.evaluate(el => {
    const workspace = el.closest('.tr-workspace');
    workspace.scrollTop += el.getBoundingClientRect().top - workspace.getBoundingClientRect().top;
  });
  await expect(testInfo.project.name === 'mobile' ? page.locator('.tr-workspace') : topCard).toHaveScreenshot('credit-bank-top.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.tr-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  if (testInfo.project.name === 'mobile') {
    const region = page.locator('.tr-table-scroll[aria-label="银行性质汇总"]');
    await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect(await region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: '报告日：2026-06-30', exact: true }).click();
  await page.getByRole('button', { name: '26Q3', exact: true }).click();
  await expect(page.getByText('数据时点：2026-09-30', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('数据时点：2026-09-30', { exact: true })).toBeVisible();
  await expect(top.locator('tbody tr').first()).toHaveText('兴业银行470.00210.30259.70');
  await expect(summary.getByRole('row', { name: /^股份制银行/ })).toContainText('1,342.00');
  await page.getByRole('link', { name: '仪表盘', exact: true }).click();
  await expect(page.getByRole('button', { name: '报告日：2026-09-30', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '授信额度（按类型）', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '银行授信情况', exact: true }).click();
  await expect(page.getByText('数据时点：2026-09-30', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('数据时点：2026-09-30', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('link', { name: '仪表盘', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});
