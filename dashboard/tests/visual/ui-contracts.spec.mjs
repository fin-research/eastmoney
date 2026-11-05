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

const hotspotEdge=(source,sourceMove,target,effectMove,articleId,contested=false)=>({source,sourceMove,target,effectMove,weight:1.2,riseWeight:0,fallWeight:1.2,contested,trend:'new',observed:1,expected:0,articleIds:[articleId],authorCount:2,lastSeenAt:'2026-09-15T02:00:00.000Z',claims:[{articleId,title:`研报${articleId}`,author:'机构甲',publishedAt:'2026-09-15T02:00:00.000Z',mechanism:`${source}压低${target}。`,basis:'observed'}]});
const hotspotGraph=(start,end)=>{
  const day=n=>new Date(Date.parse(`${end}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
  const days=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
  return {
    window:{start,end,anchor:`${end}T02:00:00.000Z`},
    coverage:{articleCount:12,claimArticleCount:5,claimCount:days,nodeCount:4,truncated:false},
    nodes:[{key:'降准',label:'降准',kind:'policy',weight:1.2,articleCount:1,lastSeenAt:'',articles:[]},{key:'dr007',label:'DR007',kind:'market',weight:2.4,articleCount:7,lastSeenAt:'',articles:[{id:'A001',title:'研报A001',author:'机构甲',publishedAt:'2026-09-15T02:00:00.000Z'},{id:'A002',title:'研报A002',author:'',publishedAt:'2026-09-14T02:00:00.000Z'}]},{key:'存单利率',label:'存单利率',kind:'market',weight:1.2,articleCount:3,lastSeenAt:'',articles:[]},{key:'地产债',label:'地产债',kind:'sector',weight:0.5,articleCount:1,lastSeenAt:'',articles:[]}],
    edges:[hotspotEdge('降准','occur','dr007','fall','A001'),hotspotEdge('dr007','fall','存单利率','fall','A002',true),hotspotEdge('地产销售','fall','地产债','fall','A003')],
    chains:[{nodes:['降准','dr007','存单利率'],edges:[0,1],weight:1.2}],
    timeline:Array.from({length:90},(_,index)=>({date:day(index-89),articles:index%3,claims:index%5+1}))
  };
};

test('hotspot graph sizes nodes by mentions, traces paths on click, searches nodes and filters by a time range',async({page})=>{
  const requested=[];
  await page.route('**/api/rag/knowledge-graph**',route=>{
    const url=new URL(route.request().url());
    const end=url.searchParams.get('end')||'2026-09-15';
    const days=Number(url.searchParams.get('days')||14);
    const start=url.searchParams.get('start')||new Date(Date.parse(`${end}T00:00:00Z`)-(days-1)*86400000).toISOString().slice(0,10);
    requested.push(url.search);
    return route.fulfill({json:hotspotGraph(start,end)});
  });
  await page.goto('/trading-research/market-hotspots');
  await expect(page.getByText('14 条主张 · 4 个节点')).toBeVisible();
  expect(requested).toEqual(['?days=14']);
  await expect(page.getByRole('img',{name:/节点大小表示研报出现次数/})).toBeVisible();

  await page.getByRole('searchbox',{name:'搜索节点'}).fill('DR007');
  await page.getByRole('list',{name:'搜索结果'}).getByRole('button',{name:/DR007/}).click();
  const detail=page.getByRole('region',{name:'节点详情'});
  await expect(detail).toContainText('DR007');
  await expect(detail).toContainText('7 篇');
  await expect(detail.getByRole('button',{name:/降准● → DR007↓/})).toBeVisible();
  await expect(detail.getByRole('button',{name:/DR007↓ → 存单利率↓/})).toBeVisible();
  // Nodes outside the traced paths fade to a tenth of their opacity.
  await expect(page.locator('.graph-chart svg [fill-opacity="0.1"]')).toHaveCount(1);
  const related=page.getByRole('region',{name:'关联文章'});
  await expect(related.getByRole('link',{name:'研报A001'})).toHaveAttribute('href','/articles/A001');
  await expect(related.getByText('未署名')).toBeVisible();
  await expect(page.getByRole('region',{name:'热点节点'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'回放'})).toHaveCount(0);

  await detail.getByRole('button',{name:/降准● → DR007↓/}).click();
  await expect(page.getByLabel('边的研报主张').getByText('研报A001')).toBeVisible();
  await expect(detail).toHaveCount(0);

  const nodeShapes=()=>page.locator('.graph-chart svg path[d^="M"]').evaluateAll(list=>list.every(path=>!/NaN/.test(path.getAttribute('d')||'')&&!/NaN/.test(path.getAttribute('transform')||'')));
  await page.getByRole('button',{name:'放大'}).click();
  await page.getByRole('button',{name:'缩小'}).click();
  expect(await nodeShapes()).toBe(true);
  await page.getByRole('button',{name:'复位'}).click();

  const chain=page.getByRole('button',{name:'降准● → DR007↓ → 存单利率↓'});
  await chain.click();
  await expect(chain).toHaveAttribute('aria-pressed','true');
  await chain.click();
  await expect(chain).toHaveAttribute('aria-pressed','false');

  await page.getByRole('searchbox',{name:'搜索节点'}).fill('存单');
  await page.getByRole('list',{name:'搜索结果'}).getByRole('button',{name:/存单利率/}).click();
  await expect(page.getByRole('region',{name:'节点详情'})).toContainText('存单利率');

  const from=page.getByRole('slider',{name:'起始日'});
  const before=Number(await from.getAttribute('aria-valuenow'));
  await from.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(from).toHaveAttribute('aria-valuenow',String(before-1));
  await expect.poll(()=>requested.length).toBe(2);
  const query=new URLSearchParams(requested[1]);
  expect(query.get('end')).toBe('2026-09-15');
  expect(Math.round((Date.parse('2026-09-15')-Date.parse(query.get('start')))/86400000)+1).toBe(15);
  await expect(page.getByText('15 条主张 · 4 个节点')).toBeVisible();

  // Dragging the start handle to the far left selects every day back to the first claim.
  const handle=await page.getByRole('slider',{name:'起始日'}).boundingBox();
  const track=await page.locator('.range-track').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(track.x+2,handle.y+handle.height/2,{steps:6});
  await page.mouse.up();
  await expect.poll(()=>requested.length).toBe(3);
  expect(new URLSearchParams(requested[2]).get('start')).toBe('2026-06-18');
  await expect(page.getByRole('slider',{name:'起始日'})).toHaveAttribute('aria-valuenow','0');

  const to=page.getByRole('slider',{name:'结束日'});
  await to.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(()=>requested.length).toBe(4);
  expect(new URLSearchParams(requested[3]).get('end')).toBe('2026-09-14');
});

test('hotspot graph shows an empty state and an error with retry',async({page})=>{
  let fail=true;
  const empty={window:{start:'2026-09-02',end:'2026-09-15',anchor:''},coverage:{articleCount:3,claimArticleCount:0,claimCount:0,nodeCount:0,truncated:false},nodes:[],edges:[],chains:[],timeline:Array.from({length:90},(_,index)=>({date:new Date(Date.parse('2026-09-15T00:00:00Z')+(index-89)*86400000).toISOString().slice(0,10),articles:0,claims:0}))};
  await page.route('**/api/rag/knowledge-graph**',route=>fail
    ?route.fulfill({status:500,json:{error:'传导图读取失败，请稍后重试'}})
    :route.fulfill({json:empty}));
  await page.goto('/trading-research/market-hotspots');
  await expect(page.getByRole('alert')).toContainText('传导图读取失败');
  fail=false;
  await page.getByRole('button',{name:'重新读取'}).click();
  await expect(page.getByText('所选时间范围内暂无因果传导数据')).toBeVisible();
  await expect(page.getByRole('slider',{name:'起始日'})).toBeVisible();
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
