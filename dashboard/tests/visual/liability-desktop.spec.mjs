import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';

test('desktop liability report retains six complete pages with readable charts',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/financing/liability-report');
  const pages=page.locator('.report-page');
  await expect(pages).toHaveCount(6);
  await expect(page.getByRole('button',{name:'导出 PDF',exact:true})).toBeEnabled();
  // A4 sheets must fit inside the real scrolling workspace for complete captures.
  await page.setViewportSize({width:1280,height:1600});
  const snapshots=['liability-page-1.png','liability-page-2.png','liability-page-3.png','liability-page-4.png','liability-page-5.png','liability-page-6.png'];
  for(let index=0;index<6;index++){
    const sheet=pages.nth(index);
    await sheet.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
    await expect(sheet).toBeInViewport({ratio:1});
    await expect(sheet.getByText(`第 ${index+1} 页 · 共 6 页`,{exact:true})).toBeVisible();
    expect(await sheet.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await expect(sheet).toHaveScreenshot(snapshots[index]);
  }
  await page.setViewportSize({width:1280,height:900});
  const peerChart=page.getByRole('region',{name:'可比券商申报及发行',exact:true}).locator('.chart-host');
  const legend=(name)=>peerChart.locator('svg').getByText(name,{exact:true});
  await legend('公募债').click();
  await expect(peerChart).toHaveAttribute('aria-label',/表示合计的柱状图，其数据是——广发证券的数据是180，0/);
  await expect(peerChart.locator('svg').getByText('232',{exact:true})).toHaveCount(0);
  await expect.poll(()=>peerChart.locator('svg').getByText('180',{exact:true}).last().evaluate(el=>Number(el.getAttribute('fill-opacity')??1))).toBe(1);
  for(const name of ['次级债','短期公司债','短期融资券']) await legend(name).click();
  await expect(peerChart).toBeVisible();
  await expect(legend('公募债')).toBeVisible();
  await legend('公募债').click();
  await expect(peerChart).toHaveAttribute('aria-label',/表示合计的柱状图，其数据是——广发证券的数据是52，0/);
  for(const name of ['次级债','短期公司债','短期融资券']) await legend(name).click();
  await expect(peerChart).toHaveAttribute('aria-label',/表示合计的柱状图，其数据是——广发证券的数据是232，0/);
  await page.getByRole('link',{name:'公募债',exact:true}).click();
  await expect(page).toHaveURL(/\/financing\/debts\/1$/);
});
