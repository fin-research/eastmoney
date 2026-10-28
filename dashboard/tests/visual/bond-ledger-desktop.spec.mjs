import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {ledgerAuditInventory,ledgerAuditReport} from './bond-ledger-fixture.mjs';

test('desktop daily ledger shows balanced metrics and recoverable management controls',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
 await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await mockResources(page);await page.setViewportSize({width:1280,height:900});
 await page.route('**/api/bond-ledger*',route=>{
   const url=new URL(route.request().url());
   return route.fulfill({json:url.searchParams.has('start')?ledgerAuditReport(url.searchParams.get('start'),url.searchParams.get('end')):ledgerAuditInventory});
 });
 await page.goto('/trading-research/bond');
 await expect(page.getByRole('region',{name:'二级池核心指标',exact:true})).toBeVisible();
 const rows=await page.locator('.ledger-metrics > *').evaluateAll(cards=>cards.map(card=>Math.round(card.getBoundingClientRect().top)));
 expect(rows).toHaveLength(6);expect(new Set(rows).size).toBe(2);expect(rows.filter(y=>y===rows[0])).toHaveLength(3);
 await expect(page.getByRole('img',{name:'二级资金池规模与年化收益率走势',exact:true}).locator('svg').getByText('6%',{exact:true})).toBeVisible();
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('bond-ledger-desktop.png');
 await expect(page.locator('.ledger-chart-grid')).toHaveScreenshot('bond-ledger-distributions-desktop.png');
 await page.getByRole('radio',{name:'交易户',exact:true}).check();
 await expect(page.getByRole('img',{name:'二级资金池规模与年化收益贡献走势',exact:true})).toBeVisible();
 await page.getByRole('radio',{name:'可供户',exact:true}).check();
 await expect(page.getByRole('radio',{name:'可供户',exact:true})).toBeChecked();
 await page.getByRole('radio',{name:'全部',exact:true}).check();
 await expect(page.getByRole('region',{name:'成交明细',exact:true})).toHaveScreenshot('bond-ledger-trades-desktop.png');
 const manage=page.getByRole('button',{name:'台账管理',exact:true});await manage.click();
 const dialog=page.getByRole('dialog',{name:'台账管理',exact:true});
 await dialog.getByRole('button',{name:'2026-09-15 数据库有台账，查看管理操作',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'2026-09-15 数据库有台账，查看管理操作',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(dialog.getByRole('button',{name:'下载',exact:true})).toBeVisible();
 await expect(dialog).toHaveScreenshot('bond-ledger-management-desktop.png');
 await dialog.getByRole('button',{name:'2026-09-14 数据库有台账，查看管理操作',exact:true}).click();
 await expect(dialog.getByText('数据库已有台账，暂无原始文件管理信息',{exact:true})).toBeVisible();
 await expect(dialog.getByRole('button',{name:'下载',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(manage).toBeFocused();
 expect(errors).toEqual([]);
});
