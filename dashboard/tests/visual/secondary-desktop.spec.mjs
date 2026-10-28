import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';

test('desktop secondary report date range shows endpoints and selected interval',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/trading-research/secondary-bond-pool');
  await expect(page.getByText('测试国债',{exact:true})).toBeVisible();
  const trigger=page.getByRole('button',{name:'选择周报数据范围',exact:true});
  await trigger.click();
  const dialog=page.getByRole('dialog',{name:'选择周报数据范围',exact:true});
  const start=dialog.getByRole('button',{name:'2026-01-01',exact:true});
  const middle=dialog.getByRole('button',{name:'2026-01-02',exact:true});
  await expect(start).toHaveAttribute('aria-pressed','true');
  await expect(middle).toHaveAttribute('aria-pressed','true');
  const startColor=await start.evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(startColor).not.toBe(await middle.evaluate(el=>getComputedStyle(el).backgroundColor));
  for(let i=0;i<8;i++)await dialog.getByRole('button',{name:'向后一个月',exact:true}).click();
  await dialog.getByRole('button',{name:'2026-09-10',exact:true}).click();
  await dialog.getByRole('button',{name:'2026-09-15',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toContainText('2026-09-10');
  await trigger.click();
  await expect(dialog.getByRole('button',{name:'2026-09-12',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(dialog.getByRole('button',{name:'2026-09-16',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(dialog).toHaveScreenshot('secondary-date-range.png');
});
