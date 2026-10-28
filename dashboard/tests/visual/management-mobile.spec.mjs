import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile management view');
  await mockResources(page);
});

test('mobile personnel list precedes the editor without horizontal overflow', async ({ page }) => {
  await page.goto('/management/people');
  const list = page.getByRole('list', { name: '人员', exact: true });
  await expect(list).toContainText('测试用户');
  await expect(list).not.toContainText('test@18.cn');
  const cards = await Promise.all([page.locator('.people-catalog').boundingBox(), page.locator('.person-editor').boundingBox()]);
  expect(cards[0].y + cards[0].height).toBeLessThanOrEqual(cards[1].y);
  expect(await page.locator('.tr-workspace').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-people-mobile.png');
});

test('mobile personnel navigation keeps loading cards in order', async ({ page }) => {
  await page.goto('/management/people?loading=1');
  await expect(page.getByRole('status', { name: '正在加载人员' })).toBeVisible();
  const cards = await Promise.all([page.locator('.people-loading__card').nth(0).boundingBox(), page.locator('.people-loading__card').nth(1).boundingBox()]);
  expect(cards[0].y + cards[0].height).toBeLessThanOrEqual(cards[1].y);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-people-loading-mobile.png');
});

test('mobile role tab shows role permissions separately', async ({ page }) => {
  await page.goto('/management/people?tab=roles');
  await expect(page.getByRole('list', { name: '人员', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: '角色', exact: true })).toBeVisible();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-role-mobile.png');
});
