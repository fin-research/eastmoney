import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {researchHistory} from './research-fixture.mjs';

test('desktop research history keeps main and small time axes readable',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.route('**/api/economic-indicators',route=>route.fulfill({json:researchHistory}));
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/trading-research/research');
  const rates=page.getByRole('region',{name:'利率与资金面',exact:true});
  await expect(rates.getByText('暂无可用数据',{exact:true})).toHaveCount(0);
  for(const name of ['利率与资金面主要利率走势','非银流动性压力利差','国债期限利差']) {
    await expect(rates.getByRole('img',{name,exact:true})).toBeVisible();
  }
  await expect(rates).toHaveScreenshot('research-rates-history.png');
  await expect(page.getByRole('region',{name:'价格',exact:true})).toHaveScreenshot('research-prices-history.png');
});
