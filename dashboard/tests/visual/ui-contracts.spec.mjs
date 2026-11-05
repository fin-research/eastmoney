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

test('hotspot graph switches window, focuses a node, highlights a chain and lists the claims of an edge',async({page})=>{
  const edge=(source,sourceMove,target,effectMove,articleId,contested=false)=>({source,sourceMove,target,effectMove,weight:1.2,riseWeight:0,fallWeight:1.2,contested,trend:'new',observed:1,expected:0,articleIds:[articleId],authorCount:2,lastSeenAt:'2026-09-15T02:00:00.000Z',claims:[{articleId,title:`研报${articleId}`,author:'机构甲',publishedAt:'2026-09-15T02:00:00.000Z',mechanism:`${source}压低${target}。`,basis:'observed'}]});
  const graph=days=>({
    window:{start:'2026-09-02',end:'2026-09-15',anchor:'2026-09-15T02:00:00.000Z'},
    coverage:{articleCount:12,claimArticleCount:5,claimCount:days,nodeCount:4,truncated:false},
    nodes:[{key:'降准',label:'降准',kind:'policy',weight:1.2,articleCount:1,lastSeenAt:''},{key:'dr007',label:'DR007',kind:'market',weight:2.4,articleCount:2,lastSeenAt:''},{key:'存单利率',label:'存单利率',kind:'market',weight:1.2,articleCount:1,lastSeenAt:''},{key:'地产债',label:'地产债',kind:'sector',weight:0.5,articleCount:1,lastSeenAt:''}],
    edges:[edge('降准','occur','dr007','fall','A001'),edge('dr007','fall','存单利率','fall','A002',true),edge('地产销售','fall','地产债','fall','A003')],
    chains:[{nodes:['降准','dr007','存单利率'],edges:[0,1],weight:1.2}]
  });
  const requested=[];
  await page.route('**/api/rag/knowledge-graph**',route=>{const url=new URL(route.request().url());requested.push(url.searchParams.get('days'));return route.fulfill({json:graph(Number(url.searchParams.get('days')))});});
  await page.goto('/trading-research/market-hotspots');
  await expect(page.getByText('14 条主张 · 5/12 篇')).toBeVisible();
  const first=page.getByRole('button',{name:/降准● 传导至 DR007↓/});
  const second=page.getByRole('button',{name:/DR007↓ 传导至 存单利率↓.*多空冲突/});
  const third=page.getByRole('button',{name:/地产销售↓ 传导至 地产债↓/});
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('边的研报主张').getByText('研报A001')).toBeVisible();
  await page.getByRole('group',{name:'热点节点'}).getByRole('button',{name:'DR007',exact:true}).click();
  await expect(third).toHaveClass(/dim/);
  await expect(first).not.toHaveClass(/dim/);
  await page.getByRole('button',{name:'降准● → DR007↓ → 存单利率↓'}).click();
  await expect(third).toHaveClass(/dim/);
  await expect(second).not.toHaveClass(/dim/);
  await page.getByRole('button',{name:'近 7 天'}).click();
  await expect(page.getByText('7 条主张 · 5/12 篇')).toBeVisible();
  expect(requested).toEqual(['14','7']);
});

test('hotspot graph shows an empty state and an error with retry',async({page})=>{
  let fail=true;
  await page.route('**/api/rag/knowledge-graph**',route=>fail
    ?route.fulfill({status:500,json:{error:'传导图读取失败，请稍后重试'}})
    :route.fulfill({json:{window:{start:'',end:'',anchor:''},coverage:{articleCount:3,claimArticleCount:0,claimCount:0,nodeCount:0,truncated:false},nodes:[],edges:[],chains:[]}}));
  await page.goto('/trading-research/market-hotspots');
  await expect(page.getByRole('alert')).toContainText('传导图读取失败');
  fail=false;
  await page.getByRole('button',{name:'重新读取'}).click();
  await expect(page.getByText('所选时间窗内暂无因果传导数据')).toBeVisible();
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
