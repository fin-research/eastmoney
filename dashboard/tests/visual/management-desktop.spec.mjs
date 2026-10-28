import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {profileAudit,notificationAudit} from './management-fixtures.mjs';

test.beforeEach(async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
});

test('desktop personnel cards align and selected name has one focus indicator',async({page})=>{
  await page.goto('/management/people');
  await expect(page.getByRole('textbox',{name:'姓名',exact:true})).toHaveValue('测试用户');
  await expect(page.getByRole('textbox',{name:'部门',exact:true})).toHaveValue('资金管理部');
  const list=page.getByRole('list',{name:'人员',exact:true});
  await expect(list).not.toContainText('test@18.cn');
  await expect(list).not.toContainText('colleague@18.cn');
  await list.getByRole('button',{name:/同事.*colleague@18.cn/}).click();
  await expect(page.getByRole('textbox',{name:'部门',exact:true})).toHaveValue('研究部');
  const selected=list.getByRole('button',{name:/测试用户.*test@18.cn/});
  await selected.click();
  const cards=await Promise.all([page.locator('.people-catalog').boundingBox(),page.locator('.person-editor').boundingBox()]);
  expect(Math.abs(cards[0].height-cards[1].height)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Tab');
  await selected.focus();
  const focus=await selected.evaluate(el=>({visible:el.matches(':focus-visible'),outline:getComputedStyle(el).outlineStyle,
    border:getComputedStyle(el).borderTopColor,clip:getComputedStyle(el).backgroundClip,shadow:getComputedStyle(el).boxShadow}));
  expect(focus.visible).toBe(true);
  expect(focus.outline).toBe('none');
  expect(focus.border).toBe('rgba(0, 0, 0, 0)');
  expect(focus.clip).toBe('border-box');
  expect(focus.shadow).not.toBe('none');
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-people-desktop.png');
});

test('desktop personnel navigation shows stable loading cards',async({page})=>{
  await page.goto('/management/people?loading=1');
  await expect(page.getByRole('status',{name:'正在加载人员'})).toBeVisible();
  const cards=await Promise.all([page.locator('.people-loading__card').nth(0).boundingBox(),page.locator('.people-loading__card').nth(1).boundingBox()]);
  expect(Math.abs(cards[0].height-cards[1].height)).toBeLessThanOrEqual(1);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-people-loading-desktop.png');
});

test('desktop role catalog identifies the selected role without changing permissions',async({page})=>{
  await page.goto('/management/people?tab=roles');
  await expect(page.getByRole('list',{name:'人员',exact:true})).toHaveCount(0);
  const roles=page.getByRole('list',{name:'角色',exact:true});
  const research=roles.getByRole('button',{name:/^研究业务组 \d+$/});
  await page.getByRole('button',{name:'授信工作台',exact:true}).click();
  await research.click();
  await expect(research).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('region',{name:'授信工作台',exact:true})).toContainText('未授权');
  const selectedColor=await research.evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(selectedColor).not.toBe(await roles.getByRole('button',{name:'新建只读角色 0',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor));
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-role-desktop.png');
  await roles.getByRole('button',{name:'新建只读角色 0',exact:true}).click();
  await expect(page.getByLabel('授权概览')).toContainText('0');
});

test('desktop profile aligns actions and keeps unsaved settings local',async({page})=>{
  const writes=[];
  await page.route('**/api/profile',route=>{
    if(route.request().method()!=='GET')writes.push(route.request().method());
    return route.fulfill({json:profileAudit});
  });
  await page.goto('/management/me');
  await expect(page.getByRole('textbox',{name:'显示姓名',exact:true})).toHaveValue(profileAudit.name);
  await expect(page.getByRole('textbox',{name:'部门',exact:true})).toHaveValue(profileAudit.department);
  const buttons=['保存个人资料','更新邮箱并退出登录','发送密码重置邮件','保存个性化配置'];
  const bounds=await Promise.all(buttons.map(name=>page.getByRole('button',{name,exact:true}).boundingBox()));
  expect(Math.abs(bounds[0].y-bounds[1].y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds[2].y-bounds[3].y)).toBeLessThanOrEqual(1);
  await page.getByRole('radio',{name:'绿涨红跌',exact:true}).click();
  await expect(page.getByRole('radio',{name:'绿涨红跌',exact:true})).toBeChecked();
  await page.getByRole('checkbox',{name:'确认修改邮箱并重新验证',exact:true}).click();
  await expect(page.getByRole('button',{name:'更新邮箱并退出登录',exact:true})).toBeDisabled();
  const logout=await page.getByRole('button',{name:'退出登录',exact:true}).boundingBox();
  const ai=await page.getByRole('button',{name:'打开 AI 面板',exact:true}).boundingBox();
  expect(logout.x+logout.width).toBeLessThan(ai.x);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-profile-desktop.png');
  expect(writes).toEqual([]);
});

test('desktop notification choices align with their channel headings',async({page})=>{
  await page.route('**/api/notifications/settings',route=>route.fulfill({json:notificationAudit}));
  await page.goto('/management/notifications');
  await expect(page.getByRole('textbox',{name:'联系邮箱',exact:true})).toHaveValue(notificationAudit.email);
  const table=page.getByRole('table');
  for(const channel of ['邮件','Telegram','Web Push']){
    const heading=await table.getByRole('columnheader',{name:channel,exact:true}).boundingBox();
    const checkbox=await table.getByRole('checkbox',{name:`Workflow 通知 · ${channel}`,exact:true}).boundingBox();
    expect(Math.abs(heading.x+heading.width/2-checkbox.x-checkbox.width/2)).toBeLessThanOrEqual(1);
  }
  await table.getByRole('checkbox',{name:'Workflow 通知 · Telegram',exact:true}).click();
  await expect(table.getByRole('checkbox',{name:'Workflow 通知 · Telegram',exact:true})).toBeChecked();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('management-notifications-desktop.png');
});
