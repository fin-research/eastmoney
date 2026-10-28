import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {hotspotAudit,policyAudit,auditArticles} from './audit-fixtures.mjs';

test.beforeEach(async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
});

test('desktop hotspot scope selection is visible and details use readable width',async({page})=>{
  await page.route('**/api/rag/hotspots',route=>route.fulfill({json:hotspotAudit}));
  await page.goto('/trading-research/market-hotspots');
  const trigger=page.getByRole('button',{name:/证据范围.*最近 20 篇/});
  await trigger.click();
  const scope=page.getByRole('dialog',{name:'配置热点证据范围',exact:true});
  await scope.getByRole('tab',{name:'日期范围',exact:true}).click();
  await expect(scope.getByLabel('开始日期')).toBeVisible();
  const colors=await scope.getByRole('tab').evaluateAll(tabs=>tabs.map(tab=>getComputedStyle(tab).backgroundColor));
  expect(colors[0]).not.toBe(colors[1]);
  await expect(scope).toHaveScreenshot('hotspot-scope-desktop.png');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const keyword=page.getByRole('button',{name:'资金面，热度 85',exact:true});
  await keyword.click();
  const detail=page.getByRole('dialog',{name:'资金面热点详情',exact:true});
  await expect(detail).toBeVisible();
  // Visibility precedes the 100ms zoom-in: 672px initially renders at 95% (638.4px).
  await expect.poll(async () => (await detail.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(640);
  await expect(detail.getByText(hotspotAudit.hotspots[0].evidence[0].evidence,{exact:true})).toBeInViewport();
  await expect(detail).toHaveScreenshot('hotspot-detail-desktop.png');
  await page.keyboard.press('Escape');
  await expect(keyword).toBeFocused();
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
