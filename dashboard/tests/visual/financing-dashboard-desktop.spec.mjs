import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';

test('desktop financing dashboard keeps balanced metrics and complete table values',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await mockResources(page);await page.setViewportSize({width:1280,height:900});
 await page.goto('/financing/?preset=all');
 await expect(page.getByRole('heading',{name:'存量负债结构',exact:true})).toBeVisible();
 const heights=await page.locator('.financing-metric-grid > *').evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().height));
 expect(heights).toHaveLength(6);expect(Math.max(...heights)-Math.min(...heights)).toBeLessThanOrEqual(1);expect(Math.max(...heights)).toBeLessThan(210);
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-dashboard-desktop.png');
 const numeric=page.locator('.project-panel tbody td:nth-child(2),.limit-card tbody td:nth-child(2),.limit-card tbody td:nth-child(3),.limit-card tbody td:nth-child(4)>strong');
 expect(await numeric.evaluateAll(cells=>cells.every(cell=>{const range=document.createRange();range.selectNodeContents(cell);const rects=Array.from(range.getClientRects());return rects.length>0&&rects.every(rect=>Math.abs(rect.top-rects[0].top)<=1);}))).toBe(true);
 const tables=page.locator('.project-panel .financing-table-scroll,.limit-card .financing-table-scroll');
 expect(await tables.evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1))).toBe(true);
 await page.getByRole('spinbutton',{name:'规模（亿元）',exact:true}).fill('30');
 await expect(page.getByText('额度校验通过，试算后剩余 90.00 亿元',{exact:false})).toBeVisible();
 await page.getByRole('spinbutton',{name:'规模（亿元）',exact:true}).fill('130');
 await expect(page.getByText('超出可用额度 10.00 亿元',{exact:false})).toBeVisible();
 await expect(page.locator('.limit-card')).toHaveScreenshot('financing-quota-desktop.png');
 await expect(page.locator('.simulator-card')).toHaveScreenshot('financing-simulation-desktop.png');
 await page.getByRole('combobox',{name:'预设筛选',exact:true}).first().selectOption('core_financing');
 await expect(page.getByRole('region',{name:'融资指标',exact:true}).getByText('410.00',{exact:true})).toBeVisible();
 await expect(page.locator('.project-panel tfoot')).toContainText('60.00');
 expect(errors).toEqual([]);
});

test('desktop financing calendar reveals busy dates without stretching every week',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
 await mockResources(page);await page.setViewportSize({width:1280,height:900});
 await page.goto('/financing/?preset=all');
 const more=page.getByRole('button',{name:'2026-09-15 更多 3 项融资事件',exact:true});
 await expect(more).toBeVisible();
 await page.getByRole('button',{name:'展开周末，显示完整日历',exact:true}).click();
 await expect(page.locator('.calendar-grid > .weekday')).toHaveCount(7);
 await page.setViewportSize({width:1280,height:1600});
 await page.locator('.calendar-card').evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));await expect(page.locator('.calendar-card')).toBeInViewport({ratio:1});
 await expect(page.locator('.calendar-card')).toHaveScreenshot('financing-calendar-desktop.png');
 await page.setViewportSize({width:1280,height:900});
 await more.click();
 const dialog=page.getByRole('dialog',{name:'2026-09-15 融资日程',exact:true});
 await expect(dialog.getByRole('link')).toHaveCount(6);
 await expect(dialog.getByRole('link',{name:'26测试证券5•债券付息0.1亿元',exact:true})).toBeInViewport();
 await expect(dialog).toHaveScreenshot('financing-calendar-more-desktop.png');
 await page.keyboard.press('Escape');await expect(more).toBeFocused();
 await page.getByRole('button',{name:'收起周末，仅显示工作日',exact:true}).click();
 await expect(page.locator('.calendar-grid > .weekday')).toHaveCount(5);
});
