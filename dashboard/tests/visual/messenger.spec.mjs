import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
test('消息记录、尝试明细和不确定结果重试确认',async({page})=>{
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  await mockResources(page);
  await page.goto('/management/messenger');
  await expect(page.getByRole('region',{name:'消息记录'})).toBeVisible();
  await expect(page.getByRole('region',{name:'发送尝试'})).toContainText('EMAIL_RATE_LIMIT');
  await expect(page.getByText('<p>节点提醒</p>',{exact:true})).toBeVisible();
  const longSubject = page.locator('.subject').filter({ hasText: 'economic-indicator-sync' });
  await expect(longSubject).toBeVisible();
  expect(await longSubject.evaluate(cell => {
    const range = document.createRange();
    range.selectNodeContents(cell.querySelector('a'));
    const box = cell.getBoundingClientRect();
    const fragments = [...range.getClientRects()];
    return fragments.length > 1 && fragments.every(rect => rect.left >= box.left && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('messenger.png');
  await page.getByRole('button',{name:'重试 中国央行：开展公开市场操作',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toContainText('重试可能重复发送');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('region',{name:'消息记录'})).toBeVisible();
  await expect(page).toHaveURL(/\/management\/messenger$/);
});

test('通知管理测试消息支持编辑、单发群发和渠道选择',async({page})=>{
  await mockResources(page);
  await page.goto('/management/messenger');
  await page.getByRole('link',{name:'测试消息',exact:true}).click();
  await expect(page).toHaveURL(/tab=test/);
  await page.reload();
  await expect(page.getByRole('navigation',{name:'标签页'}).getByRole('link',{name:'测试消息'})).toHaveAttribute('aria-current','page');
  await expect(page.getByLabel('消息内容',{exact:true})).toHaveValue('这是一条测试消息，用于确认通知渠道可以正常接收。');
  await expect(page.getByRole('button',{name:'发送测试消息',exact:true})).toBeDisabled();
  await page.getByRole('combobox',{name:'接收用户',exact:true}).selectOption('auth0|one');
  await page.getByLabel('消息内容',{exact:true}).fill('这是编辑后的测试消息。');
  await expect(page.getByRole('button',{name:'发送测试消息',exact:true})).toBeEnabled();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('messenger-test-single.png');
  await page.getByRole('combobox',{name:'发送方式',exact:true}).selectOption('multiple');
  await page.getByRole('button',{name:'选择当前结果',exact:true}).click();
  await page.getByRole('checkbox',{name:'Telegram',exact:true}).check();
  await page.getByRole('checkbox',{name:'Web Push',exact:true}).check();
  await expect(page.getByRole('button',{name:'发送测试消息（2 人）',exact:true})).toBeEnabled();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('messenger-test-bulk.png');
  await page.getByRole('button',{name:'清空',exact:true}).click();
  await expect(page.getByRole('button',{name:'发送测试消息',exact:true})).toBeDisabled();
});


test('通知标签保留真实链接并支持历史和未知值回退', async ({ page }) => {
  await mockResources(page);
  await page.goto('/management/messenger?tab=test');
  const tabs = page.getByRole('navigation', { name: '标签页' });
  await expect(tabs.getByRole('link', { name: '消息投递', exact: true })).toHaveAttribute('href', '/management/messenger?tab=delivery');
  await tabs.getByRole('link', { name: '消息投递', exact: true }).click();
  await expect(page.getByRole('region', { name: '消息记录' })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('消息内容', { exact: true })).toBeVisible();
  await page.goto('/management/messenger?tab=unknown');
  await expect(tabs.getByRole('link', { name: '消息投递', exact: true })).toHaveAttribute('aria-current', 'page');
});
