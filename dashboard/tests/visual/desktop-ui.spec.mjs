import { mockFinancialMonths } from './financing-data-fixture.mjs';
import { test, expect } from '@playwright/test';
import { mockResources, marketSnapshot } from './fixtures.mjs';

test('desktop client search stays on one row and edit dialog restores focus', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await page.goto('/financing/clients');
  const input=page.getByRole('textbox',{name:'搜索客户或别名'});
  const search=page.getByRole('button',{name:'搜索',exact:true});
  const create=page.getByRole('button',{name:'新增客户',exact:true});
  for(const width of [1440,1280]){
    await page.setViewportSize({width,height:900});
    await expect.poll(async()=>{
      const a=await input.boundingBox(),b=await search.boundingBox(),c=await create.boundingBox();
      return Math.max(Math.abs(a.y-b.y),Math.abs(a.y-c.y));
    }).toBeLessThanOrEqual(1);
    const a=await input.boundingBox();
    expect(a.width).toBeGreaterThan(200);
  }
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('clients-toolbar.png');
  const edit=page.getByRole('button',{name:'编辑银行甲',exact:true});
  await edit.click();
  const dialog=page.getByRole('dialog',{name:'编辑客户',exact:true});
  await expect(dialog.getByRole('textbox',{name:'客户名称',exact:true})).toHaveValue('银行甲');
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('clients-edit.png');
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(edit).toBeFocused();
  await input.fill('甲行');await search.click();
  await expect(page).toHaveURL(/q=%E7%94%B2%E8%A1%8C/);
  await expect(page.getByRole('button',{name:'编辑银行甲',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'编辑证券乙',exact:true})).toHaveCount(0);
});

test('desktop SOP create action remains clear of AI and opens a dismissible dialog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await page.goto('/financing/sop');
  const create = page.getByRole('button', { name: '新建 SOP', exact: true });
  const ai = page.getByRole('button', { name: '打开 AI 面板', exact: true });
  const a = await create.boundingBox(), b = await ai.boundingBox();
  expect(a.y + a.height + 12).toBeLessThanOrEqual(b.y);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('sop-actions.png');
  await create.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('sop-create.png');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(create).toBeFocused();
});

test('desktop market report retains full names and table cells at 1280 pixels', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/api/market-report*', route => route.fulfill({ json: { ...marketSnapshot,
    equities: [...marketSnapshot.equities,
      { name: '深证成指', close: 13200.23, change_pct: 1.22 },
      { name: '创业板指', close: 3100.25, change_pct: -0.83 },
      { name: '科创50', close: 1350.67, change_pct: 0.75 }],
    primary_summary: { current_amount: 30, change_amount: 5 },
    primary_issues: [{ issue_date: '09/15', issue_date_key: '2026-09-15', issuer: '国泰海通证券',
      category: '小公募', bond_names: ['26国泰海通01'], tenors: ['3年'], coupons: [2.15], amount: 30 }],
    secondary_bonds: [{ bond_id: '240001', issuer: '国泰海通证券', bond_name: '24国泰海通证券01',
      tenor_label: '3Y', tenor_years: 3, trade_yield: 1.92, valuation: 1.93 }],
  } }));
  await page.goto('/market-briefing');
  await expect(page.locator('.primary-table')).toBeVisible();
  await expect(page.locator('.primary-table__issuer')).toHaveText('国泰海通证券');
  for (const selector of ['.equity-value__name', '.equity-value strong', '.summary-strip__item strong', '.primary-table td', '.secondary-table td']) {
    const clipped = await page.locator(selector).evaluateAll(nodes => nodes.filter(node =>
      node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
    ).map(node => node.textContent));
    expect(clipped, selector).toEqual([]);
  }
  await expect(page.locator('#visual-report-panel')).toHaveScreenshot('market-report-readable.png');
});

test('desktop industry heatmap keeps names visible across market-cap sizes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop heatmap audit');
  await mockResources(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const sectors = [
    ['电子', 16, -4.93], ['银行', 14, -0.16], ['通信', 9, -7.36],
    ['电力设备', 8, -2.44], ['机械设备', 7, -3.68], ['医药生物', 6, -0.39],
    ['非银金融', 5.5, -1.76], ['食品饮料', 5, -0.17], ['石油石化', 4.5, 0.89],
    ['有色金属', 4, -3.77], ['交通运输', 3.8, -0.38], ['国防军工', 3.5, -2.35],
    ['基础化工', 3.3, -1.12], ['公用事业', 3.1, -0.57], ['汽车', 2.9, -1.03],
    ['计算机', 2.7, -2.91], ['家用电器', 2.5, -0.64], ['农林牧渔', 2.3, 0.25],
    ['房地产', 2.1, 0.46], ['煤炭', 1.9, 0.12], ['建筑装饰', 1.7, -0.82],
    ['建筑材料', 1.5, -1.26], ['钢铁', 1.3, 0.37], ['轻工制造', 1.2, -0.51],
    ['纺织服饰', 1.1, -0.73], ['社会服务', 1, 0.15], ['传媒', 0.9, -1.43],
    ['商贸零售', 0.8, 0.29], ['美容护理', 0.7, -0.35], ['环保', 0.6, -0.74],
    ['综合', 0.5, 0.08],
  ].map(([name, cap, change_pct]) => ({ name, change_pct, market_cap_yuan: cap * 1e12 }));
  await page.route('**/api/market-report*', route => route.fulfill({ json: {
    ...marketSnapshot, industries: sectors,
  } }));
  await page.goto('/market-briefing');
  const heatmap = page.locator('.equity-heatmap-stage');
  const labels = heatmap.locator('svg text');
  await expect(labels.filter({ hasText: /^电子$/ })).toHaveCount(1);
  const renderedLabels = await labels.allTextContents();
  const visibleSectors = sectors.filter(({ name }) =>
    renderedLabels.includes(name));
  expect(visibleSectors.length).toBeGreaterThanOrEqual(27);
  const bounds = await heatmap.boundingBox();
  const electronic = await labels.filter({ hasText: /^电子$/ }).boundingBox();
  const bank = await labels.filter({ hasText: /^银行$/ }).boundingBox();
  expect(electronic.x).toBeLessThan(bank.x);
  expect(electronic.y).toBeLessThan(bounds.y + bounds.height / 3);
  expect(bank.y).toBeLessThan(bounds.y + bounds.height / 3);
  await expect(heatmap).toHaveScreenshot('market-heatmap-sectors-desktop.png');
});


test('desktop financing data has balanced metrics and a compact financial editor', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop UI audit');
  await mockResources(page);
  await mockFinancialMonths(page);
  await page.goto('/financing/data');
  const financial=page.getByRole('region',{name:'月度财务数据',exact:true});
  await expect(financial.getByText('824.7991',{exact:false})).toBeVisible();
  const upload=page.getByRole('region',{name:'借入资金汇总表',exact:true});
  const a=await upload.boundingBox(),b=await financial.boundingBox();
  expect(b.y-a.y-a.height).toBeGreaterThanOrEqual(20);
  for(const width of [1440,1280]){
    await page.setViewportSize({width,height:900});
    const cards=financial.getByRole('article');
    await expect.poll(async()=>Math.abs((await cards.nth(0).boundingBox()).y-(await cards.nth(3).boundingBox()).y)).toBeLessThanOrEqual(1);
    const first=await cards.nth(0).boundingBox(),last=await cards.nth(7).boundingBox();
    expect(last.y).toBeGreaterThan(first.y);
    expect(await page.locator('.parameter-card').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1))).toBe(true);
  }
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-data.png');
  await page.getByRole('combobox',{name:'数据月份',exact:true}).selectOption('2025-12-31');
  await expect(financial.getByText('800',{exact:false})).toBeVisible();
  const edit=page.getByRole('button',{name:'编辑本月',exact:true});
  await edit.click();
  const dialog=page.getByRole('dialog',{name:'编辑月度财务数据',exact:true});
  const capital=dialog.getByRole('spinbutton',{name:'净资本（亿元）',exact:true});
  await expect(capital).toHaveValue('800');
  // Read both fields in one frame: the dialog may still be entering.
  const rowDelta=await dialog.getByRole('spinbutton').evaluateAll(inputs=>
    Math.abs(inputs[0].getBoundingClientRect().y-inputs[1].getBoundingClientRect().y));
  expect(rowDelta).toBeLessThanOrEqual(1);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-data-edit.png');
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(edit).toBeFocused();
});
