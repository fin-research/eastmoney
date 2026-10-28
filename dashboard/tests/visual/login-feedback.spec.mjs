import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';

test('verification feedback remains readable in the original page modal', async ({ page }) => {
  await mockResources(page);
  await page.goto('/auth/login?error=callback&modal=1');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '请先验证注册邮箱，再返回登录' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '重新登录' })).toBeVisible();
  await expect(dialog).toHaveScreenshot('login-verification-modal.png');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('redirect verification feedback offers an explicit retry without automatic login', async ({ page }) => {
  await mockResources(page);
  await page.goto('/auth/login?error=callback&returnTo=%2Ffinancing%2Fprojects');
  await expect(page.getByRole('heading', { name: '请先验证注册邮箱，再返回登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
  await expect(page.locator('.login-retry')).toHaveScreenshot('login-verification-redirect.png');
  await expect(page).toHaveURL(/error=callback/);
});
