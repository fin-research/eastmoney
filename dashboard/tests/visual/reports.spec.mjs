import {test, expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';
import {financingModel} from './report-fixtures.mjs';
import {mlpExplanation} from '../fixtures/issuance-mlp.mjs';

test('financing-model preserves its approved report layout',async({page})=>{
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  const requests=await mockResources(page);
  await page.goto('/trading-research/financing-model');
  await expect(page.getByText('等待',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('123.00',{exact:true})).toBeVisible();
  await expect(page.getByText('历史P45.0',{exact:false})).toBeVisible();
  await expect(page.getByRole('heading',{name:'因子贡献',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'整体结论'})).toHaveValue('首个可发行日预计票面1.85%；预测较低区间为2026-09-01至2026-09-03。最低日2026-09-03预计票面1.82%。可结合资金需求等待较低区间。');
  await expect(page.getByRole('heading',{name:'四品种对比'})).toBeVisible();
  await expect(page.getByText('57.5%',{exact:true})).toBeVisible();
  await expect(page.getByText('2026预测命中率（±5bp）',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'编辑整体结论'})).toHaveCount(0);
  await expect(page.getByText('窗口预期净节约',{exact:false})).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(()=>document.fonts.ready);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-model.png');
  const products=page.locator('.chart-card');
  await products.scrollIntoViewIfNeeded();
  await expect(products).toHaveScreenshot('financing-model-products.png');
  const factors=page.locator('.factor-panel');
  await factors.scrollIntoViewIfNeeded();
  await expect(factors).toHaveScreenshot('financing-model-factors.png');
  const supporting=page.locator('.supporting-grid');
  await supporting.scrollIntoViewIfNeeded();
  await expect(supporting).toHaveScreenshot('financing-model-supporting.png');
  expect(errors).toEqual([]);expect(requests).toEqual([]);
});

test('financing-model saves the conclusion directly from its text box',async({page})=>{
  await mockResources(page);
  let saved=null;
  await page.route('**/api/financing-model/conclusion',route=>{
    saved=route.request().postDataJSON();
    return route.fulfill({json:{
      verdict:saved.verdict,preferredWindow:saved.preferredWindow,narrative:saved.narrative,
      edited:true,updatedAt:'2026-08-24T03:00:00.000Z',
    }});
  });
  await page.goto('/trading-research/financing-model');
  const conclusion=page.getByRole('textbox',{name:'整体结论'});
  await conclusion.fill('结合资金计划，尽快启动发行。');
  await conclusion.blur();
  await expect.poll(()=>saved?.narrative).toBe('结合资金计划，尽快启动发行。');
  expect(saved.verdict).toBe('等待');
});

test('published model appears while business metrics are still loading', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockResources(page);
  const published = structuredClone(financingModel);
  delete published.business_metrics;
  let releaseMetrics;
  const metricsGate = new Promise(resolve => { releaseMetrics = resolve; });
  await page.route('**/api/financing-model/business-metrics?*', async route => {
    await metricsGate;
    await route.fulfill({json: financingModel.business_metrics});
  });
  await page.route('**/api/financing-model', route => route.fulfill({json: published}));
  try {
    await page.goto('/trading-research/financing-model');
    await expect(page.getByRole('textbox', {name: '整体结论'})).toBeVisible();
    await expect(page.getByText('123.00', {exact: true})).toHaveCount(0);
  } finally {
    releaseMetrics();
  }
  await expect(page.getByText('123.00', {exact: true})).toBeVisible();
  expect(errors).toEqual([]);
});


test('financing-model switches between issuance model dates', async ({page}) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await mockResources(page);
  const current=structuredClone(financingModel);
  current.snapshot.run_id='00000000-0000-4000-8000-000000000025';
  current.snapshot.as_of_date='2026-08-25';
  current.conclusion={...current.conclusion,verdict:'尽快发行',edited:true,narrative:'已确认资金安排，尽快发行。'};
  current.versions.unshift({runId:current.snapshot.run_id,asOfDate:'2026-08-25',generatedAt:current.snapshot.generated_at});
  const previous={...structuredClone(financingModel),versions:current.versions};
  await page.route('**/api/financing-model?*',route=>route.fulfill({json:previous}));
  await page.route('**/api/financing-model',route=>route.fulfill({json:current}));
  await page.goto('/trading-research/financing-model');
  await expect(page.getByRole('textbox',{name:'整体结论'})).toHaveValue('已确认资金安排，尽快发行。');
  await expect(page.getByRole('heading',{name:'因子贡献',exact:true})).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-model-online.png');
  await page.getByRole('combobox',{name:'融资择时模型日期版本'}).selectOption(financingModel.snapshot.run_id);
  await expect(page.getByText('等待',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('textbox',{name:'整体结论'})).toHaveValue(/预测较低区间为/);
  await page.getByRole('button',{name:'展开未来发行窗口明细'}).click();
  await expect(page.getByRole('columnheader',{name:'预计票面'})).toBeVisible();
  await expect(page.getByRole('columnheader',{name:'90%区间',exact:true})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('desktop financing seller views load their shipping institution logos',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
  await mockResources(page);
  await page.goto('/trading-research/financing-model');
  const sellers=page.getByRole('region',{name:'卖方观点',exact:true});
  await sellers.scrollIntoViewIfNeeded();
  const logos=sellers.locator('.institution-logo img');
  await expect(logos.first()).toBeVisible();
  await expect.poll(()=>logos.evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
  await expect(sellers).toHaveScreenshot('financing-seller-logos.png');
});


test('financing-model shows complete MLP contribution sources', async ({page}) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await mockResources(page);
  const current=structuredClone(financingModel);
  current.snapshot.explanation=mlpExplanation();
  current.snapshot.forecast[0].coupon_percent=current.snapshot.explanation.prediction_coupon_bp/100;
  await page.route('**/api/financing-model',route=>route.fulfill({json:current}));
  await page.goto('/trading-research/financing-model');
  const factors=page.locator('.factor-panel');
  await factors.scrollIntoViewIfNeeded();
  const chart=factors.locator('.driver-contribution-chart');
  for (const source of ['行业报价','发行人报价','发行人身份','国债收益率']) await expect(chart).toContainText(source);
  await expect(factors.getByText('全部贡献',{exact:true})).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  await expect(factors).toHaveScreenshot('financing-model-mlp-factors.png');
  await factors.getByText('路径积分明细（244项）',{exact:true}).click();
  await expect(factors.getByRole('row')).toHaveCount(245);
  await expect(factors.getByText('提前14日×发行人报价·前3个报价日',{exact:true})).toBeAttached();
  await expect(factors.getByText('缺失（训练插补）',{exact:true}).first()).toBeVisible();
  expect(errors).toEqual([]);
});


test('financing-model suspends numbers while keeping manual work accessible', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await mockResources(page);
  const current=structuredClone(financingModel);
  // Audit data remains in the response. The UI must still withhold every model output.
  current.model_status={model_version:'61492e3527e1ae367475',status:'suspended',reason:'data_quality'};
  current.conclusion={...current.conclusion,edited:true,verdict:'人工判断',preferredWindow:'下周询价',narrative:'保留人工研究结论。'};
  let saved;
  await page.route('**/api/financing-model/conclusion',route=>{
    saved=route.request().postDataJSON();
    return route.fulfill({json:{verdict:saved.verdict,preferredWindow:saved.preferredWindow,narrative:saved.narrative,edited:true,updatedAt:'2026-08-24T04:00:00Z'}});
  });
  await page.route('**/api/financing-model',route=>route.fulfill({json:current}));
  await page.goto('/trading-research/financing-model');
  await expect(page.getByRole('status')).toHaveText('数据不满足要求，暂停预测');
  await expect(page.getByRole('textbox',{name:'整体结论'})).toHaveValue('保留人工研究结论。');
  for(const name of ['四品种对比','因子贡献','未来发行窗口','模型验证'])await expect(page.getByRole('heading',{name,exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'历史择时决策记录',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'重新生成卖方观点'})).toBeDisabled();
  await expect(page.getByRole('heading',{name:'卖方观点',exact:true})).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-model-suspended.png');
  const conclusion=page.getByRole('textbox',{name:'整体结论'});
  await conclusion.fill('暂停期间更新人工研究正文。');await conclusion.blur();
  await expect.poll(()=>saved?.narrative).toBe('暂停期间更新人工研究正文。');
  expect(saved.verdict).toBe('人工判断');expect(saved.preferredWindow).toBe('下周询价');
  expect(errors).toEqual([]);
});

test('financing-model displays published timing advice without coupon placeholders',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await mockResources(page);
 const {timingAdviceSnapshot}=await import('../fixtures/timing-advice.mjs');
 const snapshot=timingAdviceSnapshot();
 const current={business_metrics:financingModel.business_metrics,model_status:{model_version:snapshot.model_version,status:'active',reason:'user_selected_exploratory'},snapshot,conclusion:{verdict:'尽快',preferredWindow:'',narrative:snapshot.base_conclusion.narrative,edited:false,updatedAt:null},sellSide:financingModel.sellSide,versions:[{runId:snapshot.run_id,asOfDate:snapshot.as_of_date,generatedAt:snapshot.generated_at}]};
 await page.route('**/api/financing-model',route=>route.fulfill({json:current}));
 await page.goto('/trading-research/financing-model');
 await expect(page.getByRole('heading',{name:'发行建议概率'})).toBeVisible();
 await expect(page.getByText('55.0',{exact:true})).toBeVisible();
 await expect(page.getByText('AAA证券公司债3Y',{exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'开发检验'})).toBeVisible();
 await expect(page.getByText('用户选定试用',{exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'四品种对比'})).toHaveCount(0);
 await expect(page.getByText('预测发行利率',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'因子贡献'})).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'整体结论'})).toHaveValue(snapshot.base_conclusion.narrative);
 await page.evaluate(()=>document.fonts.ready);
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-model-timing.png');
 await expect(page.getByRole('region',{name:'发行建议概率',exact:true})).toHaveScreenshot('financing-model-timing-probabilities.png');
 await expect(page.getByRole('region',{name:'开发检验',exact:true})).toHaveScreenshot('financing-model-timing-validation.png');
 expect(errors).toEqual([]);
});
