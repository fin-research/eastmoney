import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';

test('desktop investor filters remain horizontal and update independent distributions',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.goto('/financing/bond-investors');
  const ranking=page.getByRole('region',{name:'具体投资人情况',exact:true});
  for(const width of [1440,1280]){
    await page.setViewportSize({width,height:900});
    await ranking.getByRole('combobox',{name:'排序',exact:true}).click();
    await page.keyboard.press('Escape');
    const labels=await ranking.locator('label').evaluateAll(nodes=>nodes.map(n=>{
      const a=n.getBoundingClientRect(),b=document.getElementById(n.htmlFor).getBoundingClientRect();
      return {height:a.height,controlHeight:b.height,aligned:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<1};
    }));
    expect(labels.every(x=>x.height<x.controlHeight&&x.aligned)).toBe(true);
  }
  await expect(ranking).toHaveScreenshot('investor-filters.png');
  await expect(page.getByRole('region',{name:'累计投资机构类型分布',exact:true})).toHaveScreenshot('investor-distribution.png');
  await ranking.getByRole('combobox',{name:'排序',exact:true}).selectOption('outstanding');
  await expect(ranking.locator('tbody tr').first()).toContainText('基金乙');
  await ranking.getByRole('combobox',{name:'债券品种',exact:true}).selectOption('私募债');
  await expect(ranking.locator('tfoot')).toContainText('23.00');
  const outstanding=page.getByRole('region',{name:'存续投资机构类型分布',exact:true});
  await expect(outstanding.getByRole('combobox')).toHaveValue('total');
  await outstanding.getByRole('combobox').selectOption('私募债');
  await expect(outstanding.getByRole('status')).toHaveText('所选范围暂无投资金额');
});

test('desktop debt details group secondary fields beneath cashflows',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/financing/debts/1');
  const core=page.getByRole('region',{name:'核心信息',exact:true});
  const cash=page.getByRole('region',{name:'结构化现金流',exact:true});
  const fields=page.getByRole('region',{name:'完整字段',exact:true});
  const a=await core.boundingBox(),b=await cash.boundingBox(),c=await fields.boundingBox();
  expect(b.x).toBeGreaterThan(a.x+a.width);
  expect(c.x).toBe(b.x);
  expect(c.y).toBeGreaterThanOrEqual(b.y+b.height+15);
  expect(c.y+c.height).toBeLessThanOrEqual(a.y+a.height+1);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('debt-details.png');
  await expect(page.getByRole('link',{name:'返回仪表盘',exact:true})).toHaveAttribute('href','/financing/');
});

test('desktop financing presets show complete labels and retain selections',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/financing/filters');
  const overview=page.getByRole('region',{name:'总览筛选',exact:true});
  const calendar=page.getByRole('region',{name:'日历筛选',exact:true});
  for(const region of [overview,calendar]){
    const fits=await region.getByRole('combobox').evaluate(el=>{
      const style=getComputedStyle(el),canvas=document.createElement('canvas'),context=canvas.getContext('2d');
      context.font=style.font;
      return el.clientWidth>=context.measureText(el.selectedOptions[0].text).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight);
    });
    expect(fits).toBe(true);
  }
  await expect(overview).toHaveScreenshot('overview-preset.png');
  await expect(calendar).toHaveScreenshot('calendar-preset.png');
  await calendar.getByRole('combobox').selectOption('all');
  await expect(calendar.getByRole('button',{name:'负债品种：全部品种',exact:true})).toBeVisible();
  await expect(overview.getByRole('combobox')).toHaveValue('core_financing');
});
