import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {newsDetailAudit,articleDetailAudit,commentaryDetailAudit} from './audit-fixtures.mjs';

test.beforeEach(async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
});

test('desktop news detail recovers and shows structured content',async({page})=>{
  let attempts=0;
  await page.route('**/api/news/news-1',route=>route.fulfill(++attempts===1?{status:503,json:{error:'新闻资讯暂时不可用'}}:{json:newsDetailAudit}));
  await page.goto('/news/news-1');
  await expect(page.getByRole('alert')).toContainText('新闻资讯暂时不可用');
  await expect(page.locator('.detail-main')).toHaveScreenshot('document-retry-desktop.png');
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.getByRole('heading',{name:newsDetailAudit.title,exact:true})).toBeVisible();
  await expect(page.locator('.document-body ul')).toHaveCSS('list-style-type','disc');
  await expect(page.getByRole('link',{name:'查看关联政策',exact:true})).toHaveAttribute('href','/trading-research/policy-tracking#policy-policy-1');
  await expect(page.locator('.detail-main')).toHaveScreenshot('news-detail-desktop.png');
  await page.getByRole('link',{name:'返回政策跟踪',exact:true}).click();
  await expect(page).toHaveURL(/\/trading-research\/policy-tracking$/);
});

test('desktop research detail shows its body and related policies',async({page})=>{
  let attempts=0;
  await page.route('**/api/articles/A001',route=>route.fulfill(++attempts===1?{status:503,json:{error:'研报暂时不可用'}}:{json:articleDetailAudit}));
  await page.goto('/articles/A001');
  await expect(page.getByRole('alert')).toContainText('研报暂时不可用');
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await expect(page.getByRole('heading',{name:articleDetailAudit.title,exact:true})).toBeVisible();
  await expect(page.getByRole('table')).toContainText('发行窗口和认购需求');
  await expect(page.getByRole('complementary',{name:'关联政策',exact:true}).getByRole('link')).toHaveCount(2);
  await expect(page.locator('.detail-main')).toHaveScreenshot('article-detail-desktop.png');
});

test('desktop commentary detail wraps titles and centers standalone reports',async({page})=>{
  let attempts=0;
  await page.route('**/api/commentaries/**',route=>route.fulfill(++attempts===1?{status:503,json:{error:'点评暂时不可用'}}:{json:{...commentaryDetailAudit.commentary,policy:route.request().url().endsWith('/standalone')?null:commentaryDetailAudit.policy}}));
  await page.goto('/commentaries/archive-1');
  await expect(page.getByRole('alert')).toContainText('点评暂时不可用');
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  const title=page.getByRole('heading',{name:commentaryDetailAudit.commentary.eventName,exact:true});
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS('white-space','normal');
  expect(await title.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await expect(page.locator('.detail-main')).toHaveScreenshot('commentary-detail-desktop.png');
  await page.goto('/commentaries/standalone');
  await expect(title).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  const report=page.getByRole('region',{name:commentaryDetailAudit.commentary.eventName,exact:true});
  const box=await report.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(850);
  expect(Math.abs(box.x+box.width/2-640)).toBeLessThanOrEqual(1);
  await expect(page.locator('.detail-main')).toHaveScreenshot('commentary-standalone-desktop.png');
});
