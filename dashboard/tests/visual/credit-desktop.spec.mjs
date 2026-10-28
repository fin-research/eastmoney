import {creditDataFixture,creditDataPatch} from '../helpers/credit-data-fixture.mjs';
import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {creditFull} from './audit-fixtures.mjs';

test('desktop credit weekly report presents nonempty news and five product details',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
 await mockResources(page);
 const report=structuredClone(creditFull);
 report.institutions=['甲','乙','丙','丁'].map((suffix,index)=>({...structuredClone(creditFull.institutions[index%2]),institutionName:`银行${suffix}`,totalLimit:index?5:15,expiryDate:'2026-09-30'}));
 report.previousInstitutions=report.institutions.map((institution,index)=>({...structuredClone(institution),reportDate:report.previousDate,totalLimit:[10,8,5,5][index],expiryDate:'2026-09-14'}));
 report.weeklyNews=Array.from({length:4},(_,index)=>({
   ...report.weeklyNews[0],institutionName:report.institutions[index].institutionName,eventType:index?'renewal':'increase',previousAmount:report.previousInstitutions[index].totalLimit,currentAmount:report.institutions[index].totalLimit,
 }));
 report.recentApprovals=report.weeklyNews;
 await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(report)}));
 await page.setViewportSize({width:1280,height:900});await page.goto('/credit-workbench/weekly');
 await expect(page.getByRole('region',{name:'授信周报',exact:true}).getByRole('article')).toHaveCount(5);
 for (const card of await page.getByRole('region',{name:'授信周报',exact:true}).getByRole('article').all()) {
   await expect(card).not.toContainText('较上周');
   expect(await card.locator('.research-metric-card__detail').evaluate(el=>getComputedStyle(el).color)).toBe(await card.locator('strong').evaluate(el=>getComputedStyle(el).color));
 }
 await expect(page.getByRole('region',{name:'授信周报',exact:true}).getByRole('article').first()).toContainText('+2亿元');
 await expect(page.getByRole('region',{name:'本周授信快讯',exact:true})).toContainText('较前额增加5亿');
 await expect(page.locator('.tr-credit-news-list li')).toHaveCount(4);
 for(const row of await page.locator('.tr-credit-news-list li').all()) {
   expect(await row.evaluate(el=>getComputedStyle(el).borderWidth)).toBe('0px');
   expect(await row.evaluate(el=>getComputedStyle(el).alignItems)).toBe('center');
 }
 await expect(page.getByRole('heading',{name:'近期新增授信批复',exact:true})).toBeVisible();
 for(const header of await page.locator('.tr-credit-weekly-report thead th').all()) expect(await header.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
 await expect(page.getByRole('table',{name:'所选报表日前近6个月新增、续作和扩额授信批复',exact:true})).toContainText('同业拆借 3.00亿');
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-weekly-full-desktop.png');
});

test('credit weekly detail keeps the complete grouped header while scrolling',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop sticky header audit');
 await mockResources(page);
 const report=structuredClone(creditFull);
 report.institutions=Array.from({length:24},(_,index)=>({
   ...structuredClone(creditFull.institutions[index%2]),
   institutionName:`银行${String(index+1).padStart(2,'0')}`,
 }));
 await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(report)}));
 await page.setViewportSize({width:1280,height:900});await page.goto('/credit-workbench/weekly');
 const workspace=page.locator('.tr-workspace');
 const table=page.locator('.tr-credit-weekly-detail-table');
 await table.scrollIntoViewIfNeeded();
 await workspace.evaluate(el=>{el.scrollTop+=220});
 const workspaceTop=await workspace.evaluate(el=>el.getBoundingClientRect().top);
 const headerTop=await table.locator('thead').evaluate(el=>el.getBoundingClientRect().top);
 expect(Math.abs(headerTop-workspaceTop)).toBeLessThanOrEqual(2);
 for(const cell of await table.locator('thead tr:first-child th').all()) await expect(cell).toBeInViewport();
 await expect(workspace).toHaveScreenshot('credit-weekly-sticky-header.png');
});

test('desktop credit metrics and detail dialog stay within the viewport',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await page.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'));
  await mockResources(page);
  await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(creditFull)}));
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/credit-workbench/ledger');
  await expect(page.getByRole('rowheader',{name:'银行甲',exact:true})).toBeVisible();
  const region=page.getByRole('region',{name:'授信机构记录',exact:true});
  const bounds=await region.evaluate(el=>({width:el.clientWidth,content:el.scrollWidth}));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width+1);
  await page.getByRole('combobox',{name:'授信风险',exact:true}).selectOption('expiry');
  await expect(region.getByRole('rowheader',{name:'银行乙',exact:true})).toHaveCount(0);
  await region.getByRole('rowheader',{name:'银行甲',exact:true}).click();
  const detail=page.getByRole('dialog',{name:'授信详情',exact:true});
  await expect(region).toHaveJSProperty('scrollLeft',0);
  await expect(detail.getByRole('textbox',{name:'机构性质',exact:true})).toHaveValue('商业银行');
  const products=await detail.getByRole('group').evaluateAll(nodes=>nodes.map(n=>{
    const box=n.getBoundingClientRect(), style=getComputedStyle(n);
    return {x:box.x,y:box.y,width:box.width,bottom:box.bottom,border:style.borderTopWidth,color:style.borderTopColor,radius:parseFloat(style.borderTopLeftRadius)};
  }));
  expect(products).toHaveLength(5);
  for (const product of products) {
    expect(product.border).toBe('1px');
    expect(product.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(product.radius).toBeGreaterThanOrEqual(16);
  }
  expect(Math.max(...products.slice(0,4).map(p=>p.y))-Math.min(...products.slice(0,4).map(p=>p.y))).toBeLessThanOrEqual(1);
  expect(products[4].y).toBeGreaterThan(products[1].y);
  expect(Math.abs(products[4].x-products[1].x)).toBeLessThanOrEqual(1);
  expect(Math.abs(products[4].bottom-products[0].bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(products[4].x+products[4].width-products[3].x-products[3].width)).toBeLessThanOrEqual(1);
  const otherLabels=await detail.getByRole('group',{name:'其它',exact:true}).locator('label').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));
  expect(Math.abs(otherLabels[0]-otherLabels[1])).toBeLessThanOrEqual(1);
  await page.setViewportSize({width:1280,height:1600});
  await expect(detail).toBeInViewport({ratio:1});
  await expect(detail).toHaveScreenshot('credit-detail-dialog.png');
  const notes=detail.locator('.tr-credit-notes-grid textarea');
  const emptyHeights=await notes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(Math.max(...emptyHeights)-Math.min(...emptyHeights)).toBeLessThanOrEqual(1);
  expect(emptyHeights[0]).toBeLessThanOrEqual(48);
  await notes.first().fill('授信额度明细第一行\n授信额度明细第二行\n授信额度明细第三行');
  const filledHeights=await notes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(filledHeights[0]).toBeGreaterThan(emptyHeights[0]);
  expect(Math.max(...filledHeights)-Math.min(...filledHeights)).toBeLessThanOrEqual(1);
  await page.setViewportSize({width:1280,height:900});
  await detail.getByRole('button',{name:'关闭授信详情',exact:true}).click();
  await expect(detail.getByRole('textbox',{name:'机构性质',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'授信风险',exact:true}).selectOption('all');
  await expect(region.getByRole('rowheader',{name:'银行乙',exact:true})).toBeVisible();
});

test('credit application separates requests from editable maintenance details and derives dated status',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop credit application');
  await page.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'));
  await mockResources(page);
  const report=structuredClone(creditFull);
  let saved;
  await page.route('**/api/credit**',route=>{
    if(route.request().method()==='PATCH'){
      saved=route.request().postDataJSON();
      report.institutions[0].bankOffice=saved.changes.institution.bankOffice;
      return route.fulfill({json:creditDataPatch(report,saved)});
    }
    return route.fulfill({json:creditDataFixture(report)});
  });
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/credit-workbench/ledger');
  const region=page.getByRole('region',{name:'授信机构记录',exact:true});
  await region.getByRole('rowheader',{name:'银行甲',exact:true}).click();
  const detail=page.getByRole('dialog',{name:'授信详情',exact:true});
  await expect(detail.getByRole('textbox',{name:'机构性质',exact:true})).toBeEnabled();
  await expect(detail.getByRole('spinbutton',{name:'授信总额（亿元）',exact:true})).toBeDisabled();
  await expect(detail.getByRole('group',{name:'债券投资',exact:true}).getByRole('spinbutton',{name:'额度（亿元）',exact:true})).toBeEnabled();
  await expect(detail.getByRole('textbox',{name:'已用额度（亿元）',exact:true})).toBeDisabled();
  await expect(detail.getByRole('textbox',{name:'状态',exact:true})).toBeDisabled();
  await expect(detail.getByRole('button',{name:'保存',exact:true})).toBeVisible();
  await expect(detail.getByRole('group',{name:'其它'}).getByRole('spinbutton')).toHaveCount(1);
  await detail.getByRole('textbox',{name:'银行经办机构'}).fill('分行金融市场部');
  await detail.getByRole('button',{name:'保存',exact:true}).click();
  await expect(detail.getByRole('textbox',{name:'银行经办机构'})).toHaveValue('分行金融市场部');
  expect(saved.operation).toBe('maintenance');
  expect(saved.reportDate).toBe(report.summary.reportDate);
  expect(saved.viewDate).toBe(report.summary.reportDate);
  expect(saved.changes.institution.bankOffice).toBe('分行金融市场部');
  await detail.getByRole('button',{name:'关闭授信详情',exact:true}).click();
  await page.getByRole('button',{name:'关闭通知'}).click();
  await page.getByRole('button',{name:'授信申请',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'授信申请'});
  await expect(dialog.getByRole('textbox',{name:'机构名称'})).toBeVisible();
  await dialog.getByRole('button',{name:'续期',exact:true}).click();
  await expect(dialog.getByLabel('新到期日')).toBeVisible();
  await expect(dialog.getByRole('textbox',{name:'机构名称'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'扩额',exact:true}).click();
  await expect(dialog.getByRole('spinbutton',{name:'扩额后总额（亿元）'})).toBeVisible();
  await expect(dialog.getByRole('spinbutton',{name:'债券投资（亿元）'})).toBeVisible();
  const totalTop=(await dialog.getByRole('spinbutton',{name:'扩额后总额（亿元）'}).boundingBox()).y;
  const institutionTop=(await dialog.getByRole('combobox',{name:'授信机构'}).boundingBox()).y;
  expect(Math.abs(totalTop-institutionTop)).toBeLessThanOrEqual(1);
  const increaseRows=await dialog.locator('.tr-credit-increase-grid > label').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().y));
  expect(increaseRows).toHaveLength(4);
  expect(Math.max(...increaseRows)-Math.min(...increaseRows)).toBeLessThanOrEqual(1);
  expect(increaseRows[0]).toBeGreaterThan(totalTop);
  await expect(dialog).toHaveScreenshot('credit-application-increase.png');
  await dialog.getByRole('button',{name:'撤销',exact:true}).click();
  await expect(dialog.getByRole('checkbox',{name:'确认撤销该机构授信'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'维护',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'新增',exact:true}).click();
  await expect(dialog.getByRole('textbox',{name:'机构名称'})).toBeVisible();
  await expect(dialog.getByRole('combobox',{name:'审批状态',exact:true})).toBeVisible();
  await dialog.getByLabel('到期日',{exact:true}).fill('2027-09-30');
  await expect(dialog.getByRole('textbox',{name:'审批状态',exact:true})).toHaveValue('已获批');
  await expect(dialog.getByRole('textbox',{name:'审批状态',exact:true})).toBeDisabled();
  await dialog.getByLabel('到期日',{exact:true}).fill('');
  await expect(dialog.getByRole('combobox',{name:'审批状态',exact:true})).toBeVisible();
  await expect(dialog.getByRole('spinbutton',{name:'债券投资（亿元）'})).toBeVisible();
  await expect(dialog.getByText('已用（亿元）',{exact:true})).toHaveCount(0);
  await expect(dialog.getByText('说明',{exact:true})).toHaveCount(0);
  const applicationNotes=dialog.locator('.tr-credit-notes-grid textarea');
  const applicationEmptyHeights=await applicationNotes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(Math.max(...applicationEmptyHeights)-Math.min(...applicationEmptyHeights)).toBeLessThanOrEqual(1);
  expect(applicationEmptyHeights[0]).toBeLessThanOrEqual(48);
  await applicationNotes.first().fill('授信额度明细第一行\n授信额度明细第二行\n授信额度明细第三行');
  const applicationFilledHeights=await applicationNotes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(applicationFilledHeights[0]).toBeGreaterThan(applicationEmptyHeights[0]);
  expect(Math.max(...applicationFilledHeights)-Math.min(...applicationFilledHeights)).toBeLessThanOrEqual(1);
  await applicationNotes.first().fill('');
  await expect(dialog).toHaveCSS('opacity','1');
  await expect(dialog).toHaveScreenshot('credit-application-new.png');
});

test('credit report dates and quarter final badges support keyboard and mobile dialogs',async({page})=>{
  await mockResources(page);
  const source=structuredClone(creditFull);
  source.institutions[0].verified=true;
  source.institutions[1].verified=false;
  await page.route('**/api/credit**',route=>{
    const date=new URL(route.request().url()).searchParams.get('date') ?? source.summary.reportDate;
    const report={...source,summary:{...source.summary,reportDate:date},institutions:source.institutions.map(row=>({...row,reportDate:date,verified:date==='2026-09-30' && row.verified}))};
    return route.fulfill({json:creditDataFixture(report)});
  });
  await page.goto('/credit-workbench/ledger');
  await page.getByRole('button',{name:`报告日：${source.summary.reportDate}`,exact:true}).click();
  const picker=page.getByRole('dialog',{name:'选择报告日',exact:true});
  await expect(picker.locator('[data-calendar-grid]')).toBeVisible();
  await expect(picker.getByRole('button',{name:'26Q3',exact:true})).toBeVisible();
  await expect(picker).toBeInViewport({ratio:1});
  for (const button of await picker.getByRole('button').all()) await expect(button).toBeInViewport({ratio:1});
  expect(await picker.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await expect(picker).toHaveScreenshot('credit-report-date-picker.png');
  await picker.getByRole('button',{name:'26Q3',exact:true}).click();
  await expect(page.getByRole('button',{name:'报告日：2026-09-30',exact:true})).toBeVisible();
  const row=page.getByRole('row',{name:'银行甲授信详情',exact:true});
  await expect(row.getByText('定稿',{exact:true})).toBeVisible();
  await expect(page.getByRole('row',{name:'银行乙授信详情',exact:true}).getByText('定稿',{exact:true})).toHaveCount(0);
  await row.focus();await row.press('Enter');
  const detail=page.getByRole('dialog',{name:'授信详情',exact:true});
  await expect(detail).toBeInViewport({ratio:1});
  const toggle=detail.getByRole('switch',{name:'定稿',exact:true});
  await expect(toggle).toBeChecked();
  await toggle.focus();await toggle.press('Space');await expect(toggle).not.toBeChecked();
  await toggle.press('Space');await expect(toggle).toBeChecked();
  await expect(detail).toHaveScreenshot('credit-verified-detail.png');
  const bond=detail.getByRole('group',{name:'债券投资',exact:true});
  await expect(bond.getByRole('button',{name:'一级发行（亿元）',exact:true})).toBeEnabled();
  await bond.getByRole('spinbutton',{name:'已用（亿元）',exact:true}).fill('1');
  await expect(bond.getByRole('spinbutton',{name:'二级买卖（亿元）',exact:true})).toHaveValue('-0.5');
  await expect(bond.getByRole('spinbutton',{name:'可用（亿元）',exact:true})).toHaveValue('2');
  await bond.getByRole('spinbutton',{name:'可用（亿元）',exact:true}).fill('0');
  await expect(bond.getByRole('spinbutton',{name:'二级买卖（亿元）',exact:true})).toHaveValue('1.5');
  await expect(bond.getByRole('spinbutton',{name:'已用（亿元）',exact:true})).toHaveValue('3');
  await expect(detail.getByLabel('记录日期',{exact:true})).toHaveCount(0);
  const note=bond.getByRole('textbox',{name:'说明',exact:true});
  const before=(await note.boundingBox()).height;
  await note.fill('第一行\n第二行\n第三行\n第四行\n第五行');
  expect((await note.boundingBox()).height).toBeGreaterThan(before);
  expect(await note.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  expect(await detail.locator('.tr-credit-item-grid').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.keyboard.press('Escape');await expect(detail).toHaveCount(0);await expect(row).toBeFocused();
  await page.getByRole('button',{name:'报告日：2026-09-30',exact:true}).click();
  await page.getByRole('dialog',{name:'选择报告日',exact:true}).getByRole('button',{name:'26Q4',exact:true}).click();
  await expect(page.getByRole('button',{name:'报告日：2026-12-31',exact:true})).toBeVisible();
  await expect(page.getByText('定稿',{exact:true})).toHaveCount(0);
});

test('credit multisort preserves priorities and restores the default order',async({page})=>{
 await mockResources(page);
 const report=structuredClone(creditFull);
 report.recentApprovals=[];report.weeklyNews=[];
 report.institutions=[['银行甲','股份行',5],['银行乙','股份行',20],['银行丙','政策性银行',2],['银行丁','城商行',50],['银行戊','股份行',50]].map(([institutionName,institutionType,totalLimit])=>({...structuredClone(creditFull.institutions[0]),institutionName,institutionType,totalLimit}));
 await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(report)}));
 await page.goto('/credit-workbench/ledger');
 const table=page.getByRole('table',{name:'授信一览表',exact:true});
 const names=table.locator('tbody th[scope=row]');
 const type=table.getByRole('button',{name:/^机构性质/});
 const limit=table.getByRole('button',{name:/^总额度/});
 await expect(names).toHaveText(['银行丙','银行戊','银行乙','银行甲','银行丁']);
 const categories=table.locator('th[scope=rowgroup]');
 await expect(categories).toHaveText(['政策性银行','股份行','城商行']);
 await expect(categories.nth(1)).toHaveAttribute('rowspan','3');
 await categories.nth(1).click();await expect(page.getByRole('dialog',{name:'授信详情',exact:true})).toHaveCount(0);
 const categoryColor=await categories.nth(1).evaluate(node=>getComputedStyle(node).backgroundColor);
 await expect(type).toContainText('↑');await expect(limit).toContainText('↓1');
 await expect(type).toHaveAccessibleName(/^机构性质\s*分类升序$/);
 await expect(limit).toHaveAccessibleName(/^总额度\s*组内第1排序，降序$/);
 await table.scrollIntoViewIfNeeded();
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-multisort-default.png');
 await type.click();await expect(type).toContainText('↓');
 await expect(categories).toHaveText(['城商行','股份行','政策性银行']);
 expect(await categories.nth(1).evaluate(node=>getComputedStyle(node).backgroundColor)).toBe(categoryColor);
 await expect(type).toHaveAccessibleName(/^机构性质\s*分类降序$/);
 await type.click();await expect(limit).toContainText('↓1');
 await expect(names).toHaveText(['银行丙','银行戊','银行乙','银行甲','银行丁']);
 await type.press('Enter');await expect(type).toContainText('↑');
 await expect(names).toHaveText(['银行丙','银行戊','银行乙','银行甲','银行丁']);
 await table.getByRole('button',{name:/^授信主体/}).click();
 await expect(table.getByRole('button',{name:/^授信主体/})).toContainText('↑2');
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-multisort-custom.png');
 await page.getByRole('button',{name:'清除排序',exact:true}).click();
 await expect(names).toHaveText(['银行丙','银行甲','银行戊','银行乙','银行丁']);
 await expect(page.getByRole('button',{name:'清除排序',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'默认排序',exact:true}).click();
 await expect(names).toHaveText(['银行丙','银行戊','银行乙','银行甲','银行丁']);
 await expect(table.getByRole('columnheader',{name:'序号',exact:true})).toHaveCount(0);
 await expect(table.getByRole('columnheader').first()).toContainText('机构性质');
 report.institutions.push(...['国有行','国有银行'].map((institutionType,index)=>({...structuredClone(report.institutions[0]),institutionName:index?'银行庚':'银行己',institutionType})));
 await page.reload();
 await expect(table.locator('th[scope=rowgroup]').filter({hasText:'国有行'})).toHaveCount(1);
 await expect(table.locator('th[scope=rowgroup]').filter({hasText:'国有行'})).toHaveAttribute('rowspan','2');
 await page.getByRole('searchbox',{name:'搜索授信机构',exact:true}).fill('银行己');
 await expect(table.locator('th[scope=rowgroup]')).toHaveCount(1);
 await expect(table.locator('th[scope=rowgroup]')).toHaveAttribute('rowspan','1');
 await expect(names).toHaveText(['银行己']);
 const bankRow=table.getByRole('row',{name:'银行己授信详情',exact:true});await bankRow.focus();await bankRow.press('Space');
 await expect(page.getByRole('dialog',{name:'授信详情',exact:true})).toBeVisible();
});

test('credit overview charts display all categories and products',async({page},testInfo)=>{
 await mockResources(page);
 const report=structuredClone(creditFull);
 report.institutions=['政策性银行','国有行','国有银行','股份行','城商行','农商行','民营银行','外资行'].map((institutionType,index)=>({...structuredClone(creditFull.institutions[index%2]),institutionName:`银行${index+1}`,institutionType,totalLimit:(index+1)*10,expiryDate:index===7?null:'2027-06-30'}));
 report.institutions[0].items.forEach(item=>item.limitAmount=null);
 await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(report)}));
 await page.goto('/credit-workbench');
 await expect(page.locator('.tr-credit-chart-grid').getByText('已登记',{exact:true})).toHaveCount(0);
 await expect(page.getByText('60%关注 · 80%预警',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('table',{name:'授信一览表',exact:true})).toHaveCount(0);
 const grid=page.locator('.tr-credit-chart-grid');
 await expect(grid.locator('.tr-panel-heading h2')).toHaveText(['授信额度（按类型）','已用额度（按类型）','使用率（按类型）','授信额度（按品种）','已用额度（按品种）','使用率（按品种）','授信额度 Top10','已用额度 Top10','使用率 Top10']);
 const boxes=await grid.locator(':scope > section').evaluateAll(cards=>cards.map(card=>{const {x,y,width,height}=card.getBoundingClientRect();return {x,y,width,height};}));
 expect(boxes).toHaveLength(9);
 for(let i=0;i<boxes.length;i++) {
   if(testInfo.project.name==='desktop') {
     expect(Math.abs(boxes[i].y-boxes[Math.floor(i/3)*3].y)).toBeLessThan(1);
     expect(Math.abs(boxes[i].x-boxes[i%3].x)).toBeLessThan(1);
     if(i%3) expect(boxes[i].x).toBeGreaterThan(boxes[i-1].x);
   } else {
     expect(Math.abs(boxes[i].x-boxes[0].x)).toBeLessThan(1);
     if(i) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i-1].y+boxes[i-1].height);
   }
 }
 for(const [title,snapshot] of [
   ['授信额度（按类型）','credit-overview-bank-limits.png'],['已用额度（按类型）','credit-overview-bank-usage.png'],['使用率（按类型）','credit-overview-bank-utilization.png'],
   ['授信额度（按品种）','credit-overview-product-limits.png'],['已用额度（按品种）','credit-overview-product-usage.png'],['使用率（按品种）','credit-overview-product-utilization.png'],['授信状态','credit-overview-status.png'],
   ['授信额度 Top10','credit-overview-top-limits.png'],['已用额度 Top10','credit-overview-top-usage.png'],['使用率 Top10','credit-overview-top-utilization.png'],['到期期限分布','credit-overview-expiry.png'],['授信额度使用率','credit-overview-risk.png'],['授信预警','credit-overview-alerts.png']]){
   const region=page.getByRole('region',{name:title,exact:true});await region.scrollIntoViewIfNeeded();
   await expect(region).toHaveScreenshot(snapshot);
 }
 await expect(page.getByRole('region',{name:'授信状态',exact:true}).locator('.tr-chart-host')).toHaveAttribute('aria-label','授信状态');
});


test('credit usage drilldowns preserve drafts and open financing debt details',async({page})=>{
 await mockResources(page);
 const report=structuredClone(creditFull);
 await page.route('**/api/credit**',route=>{
  const params=new URL(route.request().url()).searchParams;
  if(params.get('view')==='usage') {
   const type=params.get('type'),name=params.get('institution');
   return route.fulfill({json:{reportDate:params.get('date'),institutionName:name,type,linked:true,totalUsed:type==='interbank_lending'?0:1.5,totalCount:type==='interbank_lending'?0:1,offset:0,
    items:type==='interbank_lending'?[]:[{id:'1',name:type==='bond_investment'?'26东财证券01':'吉祥231号收益凭证',clientName:name,amount:1.5,startDate:'2026-08-01',maturityDate:'2027-08-01'}]}});
  }
  return route.fulfill({json:creditDataFixture(report)});
 });
 await page.goto('/credit-workbench/ledger');
 await page.getByRole('rowheader',{name:'银行甲',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'授信详情',exact:true});
 await detail.getByRole('textbox',{name:'银行经办机构'}).fill('未保存分行');
 await detail.getByRole('group',{name:'债券投资',exact:true}).getByRole('spinbutton',{name:'已用（亿元）',exact:true}).fill('1');
 for(const [button,label] of [['一级发行（亿元）','26东财证券01'],['收益凭证已用（亿元）','吉祥231号收益凭证'],['同业拆借已用（亿元）',null]]) {
  const trigger=detail.getByRole('button',{name:button,exact:true});await trigger.focus();await trigger.press('Enter');
  const usage=detail.getByRole('region',{name:'融资条目',exact:true});
  const back=usage.getByRole('button',{name:'返回授信详情',exact:true});await expect(back).toBeFocused();
  if(label) {await expect(usage.getByRole('link',{name:label})).toHaveAttribute('href','/financing/debts/1');await expect(usage.getByRole('table')).toContainText('1.50');}
  else await expect(usage).toContainText('暂无存续融资条目');
  if(button==='一级发行（亿元）') await expect(detail).toHaveScreenshot('credit-usage-details.png');
  await back.press('Enter');await expect(trigger).toBeFocused();
  await expect(detail.getByRole('textbox',{name:'银行经办机构'})).toHaveValue('未保存分行');
  await expect(detail.getByRole('group',{name:'债券投资',exact:true}).getByRole('spinbutton',{name:'二级买卖（亿元）',exact:true})).toHaveValue('-0.5');
 }
 await detail.getByRole('textbox',{name:'备注',exact:true}).fill(Array(12).fill('长备注').join('\n'));
 await detail.getByRole('textbox',{name:'备注',exact:true}).focus();await page.keyboard.press('End');
 await expect(detail.getByRole('textbox',{name:'备注',exact:true})).toBeInViewport();
 expect(await detail.locator('.dialog-body').evaluate(el=>getComputedStyle(el).scrollbarWidth)).toBe('none');
 await detail.getByRole('button',{name:'收益凭证已用（亿元）',exact:true}).click();
 await detail.getByRole('link',{name:'吉祥231号收益凭证',exact:true}).click();
 await expect(page).toHaveURL(/\/financing\/debts\/1$/);
 await expect(page.getByRole('heading',{name:'吉祥231号收益凭证',exact:true})).toBeVisible();
});

test('credit usage ignores late requests after returning and reopening another institution',async({page})=>{
 await mockResources(page);
 let resolveOld;
 const pending=new Promise(resolve=>resolveOld=resolve);
 await page.route('**/api/credit**',async route=>{
  const params=new URL(route.request().url()).searchParams;
  if(params.get('view')==='usage'){
   if(params.get('institution')==='银行甲' && params.get('type')==='bond_investment') await pending;
   return route.fulfill({json:{reportDate:params.get('date'),institutionName:params.get('institution'),type:params.get('type'),linked:true,totalUsed:1,totalCount:1,offset:0,
    items:[{id:'1',name:params.get('institution')+'融资',clientName:params.get('institution'),amount:1,startDate:'2026-08-01',maturityDate:null}]}});
  }
  return route.fulfill({json:creditDataFixture(creditFull)});
 });
 await page.goto('/credit-workbench/ledger');await page.getByRole('rowheader',{name:'银行甲',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'授信详情',exact:true});
 await detail.getByRole('button',{name:'一级发行（亿元）',exact:true}).click();await expect(detail.getByRole('status')).toContainText('加载中');
 await detail.getByRole('button',{name:'返回授信详情'}).click();await detail.getByRole('button',{name:'关闭授信详情'}).click();
 await page.getByRole('rowheader',{name:'银行乙',exact:true}).click();await detail.getByRole('button',{name:'一级发行（亿元）',exact:true}).click();
 await expect(detail.getByRole('link',{name:'银行乙融资',exact:true})).toBeVisible();
 const oldResponse=page.waitForResponse(response=>response.url().includes('view=usage') && new URL(response.url()).searchParams.get('institution')==='银行甲');
 resolveOld();await oldResponse;
 await expect(detail.getByRole('link',{name:'银行甲融资',exact:true})).toHaveCount(0);
});


test('credit usage retries failures and omits financing links without data read visibility',async({page})=>{
 await mockResources(page);let attempts=0;
 await page.route('**/api/credit**',route=>{
  const params=new URL(route.request().url()).searchParams;
  if(params.get('view')==='usage') {
   if(++attempts===1) return route.fulfill({status:503,json:{error:'融资条目加载失败'}});
   return route.fulfill({json:{reportDate:params.get('date'),institutionName:params.get('institution'),type:params.get('type'),linked:true,totalUsed:1,totalCount:1,offset:0,
    items:[{id:'1',name:'只读认购条目',clientName:'银行甲',amount:1,startDate:'2026-08-01',maturityDate:null}]}});
  }
  return route.fulfill({json:creditDataFixture(creditFull)});
 });
 await page.goto('/credit-workbench/ledger?withoutFinancingRead');await page.getByRole('rowheader',{name:'银行甲',exact:true}).click();
 const detail=page.getByRole('dialog',{name:'授信详情',exact:true});await detail.getByRole('button',{name:'一级发行（亿元）',exact:true}).click();
 await expect(detail.getByRole('alert')).toContainText('融资条目加载失败');await detail.getByRole('button',{name:'重试',exact:true}).click();
 await expect(detail.getByRole('table')).toContainText('只读认购条目');await expect(detail.getByRole('link')).toHaveCount(0);
 await detail.getByRole('button',{name:'返回授信详情'}).click();await expect(detail.getByRole('button',{name:'一级发行（亿元）',exact:true})).toBeFocused();
});


test('credit weekly empty news uses standard text and unchanged metrics say flat',async({page})=>{
 await mockResources(page);
 const report=structuredClone(creditFull);
 report.weeklyNews=[];report.recentApprovals=[];
 report.previousInstitutions=structuredClone(report.institutions);
 await page.route('**/api/credit**',route=>route.fulfill({json:creditDataFixture(report)}));
 await page.goto('/credit-workbench/weekly');
 const empty=page.getByRole('region',{name:'本周授信快讯',exact:true}).getByText('本周暂无',{exact:true});
 await expect(empty).toBeVisible();
 expect(await empty.evaluate(el=>getComputedStyle(el).fontWeight)).toBe('400');
 const cards=page.getByRole('region',{name:'授信周报',exact:true}).getByRole('article');
 await expect(cards).toHaveCount(5);
 for(const card of await cards.all()) await expect(card).toContainText('持平');
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('credit-weekly-empty.png');
});
