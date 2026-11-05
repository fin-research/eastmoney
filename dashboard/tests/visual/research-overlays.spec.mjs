import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {policyAudit,auditArticles} from './audit-fixtures.mjs';

test.beforeEach(async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
});

test('desktop policy association choices remain square and cancel preserves the list',async({page})=>{
  await page.route('**/api/policies?**',route=>{
    const category=new URL(route.request().url()).searchParams.get('category');
    return route.fulfill({json:{policies:policyAudit.filter(p=>!category||p.category===category)}});
  });
  await page.route('**/api/policies/articles?**',route=>route.fulfill({json:{articles:auditArticles}}));
  await page.goto('/trading-research/policy-tracking');
  const card=page.getByRole('region',{name:policyAudit[0].title,exact:true});
  await expect(card).toBeVisible();
  await expect(card).toHaveScreenshot('policy-card-desktop.png');
  const edit=card.getByRole('button',{name:'调整关联',exact:true});
  await edit.click();
  const dialog=page.getByRole('dialog',{name:policyAudit[0].title,exact:true});
  const choice=dialog.getByRole('checkbox').first();
  await expect(choice).toBeChecked();
  const rect=await choice.boundingBox();
  expect(Math.abs(rect.width-rect.height)).toBeLessThanOrEqual(1);
  await choice.click();
  await expect(dialog.getByText('已选择 1 篇',{exact:true})).toBeVisible();
  await expect(dialog).toHaveScreenshot('policy-association-desktop.png');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(edit).toBeFocused();
  await expect(card.getByRole('heading',{name:'关联研报 2',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'政策类型',exact:true}).selectOption('fiscal');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('heading',{name:policyAudit[1].title,exact:true})).toBeVisible();
});

test('desktop commentary preview prioritizes the report and returns to its draft',async({page})=>{
  const {commentaryAudit}=await import('./audit-fixtures.mjs');
  await page.route('**/api/commentaries**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/commentaries'?{items:[commentaryAudit],hasMore:false}:commentaryAudit}));
  await page.goto('/trading-research/tracking-commentary?id=archive-1');
  await expect(page.getByRole('textbox',{name:'主题',exact:true})).toHaveValue(commentaryAudit.eventName);
  await page.getByRole('button',{name:'预览',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'主题',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'点评预览',exact:true})).toBeInViewport();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('tracking-reading-desktop.png');
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'主题',exact:true})).toHaveValue(commentaryAudit.eventName);
  await expect(page.getByRole('textbox',{name:'跟踪点评',exact:true})).toHaveValue(commentaryAudit.commentary);
});
