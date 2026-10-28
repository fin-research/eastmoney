import { test, expect } from '@playwright/test';
import { mockResources, credit } from './fixtures.mjs';
import { creditItemTypes } from '../../src/lib/credit/types.ts';
import { creditCalendarDataFixture } from '../helpers/credit-data-fixture.mjs';

let errors, requests;
test.beforeEach(async ({page}) => {
  errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  requests=await mockResources(page);
});
test.afterEach(()=>{ expect(errors).toEqual([]); expect(requests).toEqual([]); });

test('permission search keeps the active scope visible and recoverable',async({page})=>{
  await page.goto('/management/permissions');
  const pool=page.getByRole('button',{name:'二级债券池',exact:true});
  const all=page.getByRole('button',{name:'全部范围',exact:true});
  await pool.click();
  await page.getByRole('searchbox',{name:'搜索权限'}).fill('市场');
  await expect(pool).toBeVisible();
  await expect(pool).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('status')).toHaveText('无匹配权限');
  const selectedBackground=await pool.evaluate(node=>getComputedStyle(node).backgroundColor);
  expect(selectedBackground).not.toBe(await all.evaluate(node=>getComputedStyle(node).backgroundColor));
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('permissions-filtered.png');
  await all.click();
  await expect(page.getByRole('region',{name:'市场研究',exact:true})).toBeVisible();
  await expect(page.getByRole('searchbox',{name:'搜索权限'})).toHaveValue('市场');
});

test('Maia multiselect restores focus and survives reopening and clearing',async({page})=>{
  await page.goto('/ui-contracts');
  const trigger=page.getByRole('button',{name:/负债品种：/});
  await trigger.click();
  await page.getByRole('checkbox',{name:'固收',exact:true}).check();
  await expect(trigger).toContainText('固收');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  await trigger.click();
  await page.getByRole('button',{name:'全部品种',exact:true}).click();
  await expect(trigger).toContainText('全部品种');
  await expect(page.getByRole('checkbox',{name:'固收',exact:true})).not.toBeChecked();
  await page.getByRole('heading',{name:'组件交互'}).click();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
});

test('Bits dialog traps focus, blocks cancellation during save and restores trigger focus',async({page})=>{
  await page.goto('/ui-contracts');
  const trigger=page.getByRole('button',{name:'打开表单'});
  await trigger.click();
  const dialog=page.getByRole('dialog',{name:'编辑表单'});
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox',{name:'项目名称'}).fill('保留输入');
  await page.getByRole('button',{name:'模拟保存中'}).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox',{name:'项目名称'})).toHaveValue('保留输入');
  await page.getByRole('button',{name:'恢复编辑'}).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('关闭次数：1');
  await trigger.click();
  await page.getByRole('button',{name:'关闭表单'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('关闭次数：2');
});

test('credit calendar supports independent multiselect and retains filters across months',async({page})=>{
  await page.route('**/api/credit**',route=>{
    const month=new URL(route.request().url()).searchParams.get('month')??'2026-09';
    return route.fulfill({json:creditCalendarDataFixture(credit,month,creditItemTypes)});
  });
  await page.goto('/credit-workbench/calendar');
  const visible=page.locator('.tr-credit-calendar-event strong');
  await expect(visible).toHaveCount(9);
  const trigger=label=>page.getByRole('button',{name:new RegExp(`^${label}：`)});
  async function toggle(group,label){
    const button=trigger(group);
    if(await button.getAttribute('aria-expanded')!=='true')await button.click();
    await page.getByRole('checkbox',{name:label,exact:true}).click();
  }
  await toggle('额度','新增'); await expect(visible).toHaveCount(6);
  await toggle('额度','到期'); await expect(visible).toHaveCount(7);
  await page.keyboard.press('Escape');
  await toggle('已用','债券投资'); await expect(visible).toHaveText(['bond_investment','expiry','new']);
  await toggle('已用','收益凭证'); await expect(visible).toHaveCount(4);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'下一个月',exact:true}).click();
  await expect(visible).toHaveCount(4);
  async function all(group){await trigger(group).click();await page.getByRole('dialog',{name:group,exact:true}).getByRole('button',{name:'全部',exact:true}).click();await page.keyboard.press('Escape');}
  await all('已用'); await expect(visible).toHaveCount(7);
  await all('额度'); await expect(visible).toHaveCount(10);
  await toggle('额度','续作/扩额'); await expect(visible).toHaveCount(7);
  await expect(visible).toContainText(['increase','renewal']);
  await expect(visible.filter({hasText:/^new$/})).toHaveCount(0);
});

test('hotspot scope tabs and detail dialog support keyboard dismissal and restore focus',async({page})=>{
  await page.route('**/api/rag/hotspots',route=>route.fulfill({json:{
    date:'2026-09-15',generatedAt:'2026-09-15T10:00:00+08:00',marketSummary:'资金价格平稳，关注后续公开市场操作。',
    scope:{mode:'rolling',rollingCount:20,articleCount:20,firstPublishedAt:'2026-09-14',lastPublishedAt:'2026-09-15'},
    hotspots:[{keyword:'资金面',aliases:['资金价格'],explanation:'公开市场操作影响短端资金价格。',drivers:['公开市场操作'],conflicts:[],heat:85,confidence:'high',sourceLabel:'多来源',assetImpacts:{fixedIncome:'关注短端利率',equities:'关注流动性'},evidence:[{articleId:'A001',evidence:'短端资金价格平稳。'}]}],relationships:[],watchItems:[],coverage:{articleCount:20,analyzedArticleIds:['A001']}
  }}));
  await page.goto('/trading-research/market-hotspots');
  const scope=page.getByRole('button',{name:/证据范围.*最近 20 篇/});
  await scope.click();
  const configuration=page.getByRole('dialog',{name:'配置热点证据范围'});
  await expect(configuration).toBeVisible();
  await expect(configuration.getByRole('button',{name:'关闭配置'})).toBeFocused();
  await page.getByRole('tab',{name:'滚动篇数'}).click();
  await page.getByRole('tab',{name:'滚动篇数'}).press('ArrowRight');
  await expect(page.getByRole('tab',{name:'日期范围'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByLabel('开始日期')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(scope).toBeFocused();
  const keyword=page.getByRole('button',{name:'资金面，热度 85',exact:true});
  await keyword.click();
  await expect(page.getByRole('dialog',{name:'资金面热点详情'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'资产传导'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'资金面热点详情'})).toHaveCount(0);
  await expect(keyword).toBeFocused();
});


test('available buttons expose hover feedback and disabled controls keep a neutral cursor',async({page})=>{
 await page.goto('/ui-contracts');
 const button=page.getByRole('button',{name:'打开表单',exact:true});
 const background=await button.evaluate(node=>getComputedStyle(node).backgroundColor);
 if(await page.evaluate(()=>matchMedia('(hover: hover)').matches)){
   await button.hover();
   await expect.poll(()=>button.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe(background);
 }
 expect(await button.evaluate(node=>getComputedStyle(node).cursor)).toBe('pointer');
 expect(await page.getByRole('button',{name:'原生按钮',exact:true}).evaluate(node=>getComputedStyle(node).cursor)).toBe('pointer');
 for(const name of ['禁用按钮','ARIA 禁用按钮','数据禁用按钮']){
   const disabled=page.getByRole('button',{name,exact:true});
   expect(await disabled.evaluate(node=>getComputedStyle(node).cursor)).not.toBe('pointer');
 }
 const link=page.getByRole('link',{name:'禁用链接',exact:true});
 await expect(link).not.toHaveAttribute('href');
 expect(await link.evaluate(node=>getComputedStyle(node).cursor)).not.toBe('pointer');
 expect(await link.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('none');
 await page.goto('/credit-workbench/ledger');
 const sort=page.getByRole('button',{name:/^机构性质/});
 const before=await sort.evaluate(node=>getComputedStyle(node).backgroundColor);
 if(await page.evaluate(()=>matchMedia('(hover: hover)').matches)){
   await sort.hover();
   await expect.poll(()=>sort.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe(before);
 }
 expect(await sort.evaluate(node=>getComputedStyle(node).cursor)).toBe('pointer');
});
