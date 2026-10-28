import { test, expect } from '@playwright/test';
import { mockResources } from './fixtures.mjs';

async function closeAiSurfaces(page) {
  const closePanel = page.getByRole('button', { name: '关闭 AI 面板' });
  if (await closePanel.isVisible()) {
    await closePanel.click();
    await expect(page.getByRole('complementary', { name: 'AI 任务面板' })).not.toBeVisible();
  }
  const notifications = page.getByRole('button', { name: '关闭通知' });
  while (await notifications.count()) {
    const count = await notifications.count();
    await notifications.first().click();
    await expect(notifications).toHaveCount(count - 1);
  }
}

const original = {
  id:'archive-1',policyId:null,type:'current_affairs',eventName:'资金价格下移与融资窗口',sources:'研究机构甲',eventPublishedAt:'2026-09-15',commentaryDate:'2026-09-15',
  eventSummary:'资金需求回落，融资窗口打开。',commentary:'1. 资金价格下移打开融资窗口\n资金需求回落，负债成本下降，公司债发行具备有利条件。',recommendation:'融资发行方面，前置中长期公司债发行，锁定当前负债成本。',
  model:null,promptVersion:null,generatedAt:null,edited:true,updatedAt:'2026-09-15T03:00:00Z',origin:'import',originalText:'【核心结论】\n资金需求回落，融资窗口打开。',sourceFiles:[{name:'时事快评.docx',sha256:'test'}],evidence:[],search:null,
};
let stored, unexpected, errors, pdfBytes;
test.beforeEach(async ({page}) => {
  pdfBytes=null; stored=structuredClone(original); errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-15T11:00:00+08:00'));
  unexpected=await mockResources(page);
  await page.route('**/api/commentaries**',async route=>{
    const url=new URL(route.request().url());const method=route.request().method();
    if(url.pathname.endsWith('/pdf')) {
      if(method==='GET')return route.fulfill({contentType:'application/pdf',body:pdfBytes});
      expect(route.request().headers()['content-type']).toBe('application/pdf');pdfBytes=route.request().postDataBuffer();
      expect(pdfBytes.subarray(0,5).toString()).toBe('%PDF-');
      return route.fulfill({json:{revisionAt:stored.updatedAt,key:'research-commentary/时事快评/archive-1/v1.pdf',fileName:'点评.pdf',sha256:'hash',size:pdfBytes.length,archivedAt:'2026-09-15T03:03:00Z'}});
    }
    if(url.pathname.endsWith('/generate')) {
      const input=route.request().postDataJSON();expect(input.startDate).toBe('2026-09-09');
      stored={...stored,commentary:'1. 融资需求下降\n资金需求回落，融资成本下移。',edited:false,origin:'ai',updatedAt:'2026-09-15T03:02:00Z',evidence:[{sourceId:'S1',sourceKey:'report/2026-09-15/报告.md',title:'融资窗口分析',institution:'研究机构甲',publishedAt:'2026-09-15',section:'融资需求下降',text:'资金需求回落，融资成本下移。',startOffset:0,endOffset:18}]};
      return route.fulfill({contentType:'text/event-stream',body:`event: progress\ndata: 检索研报\n\nevent: result\ndata: ${JSON.stringify(stored)}\n\n`});
    }
    if(url.pathname.endsWith('/revisions'))return route.fulfill({json:{revisions:[{savedAt:original.updatedAt,content:original}]}});
    if(method==='PUT') { const body=route.request().postDataJSON();expect(body.updatedAt).toBe(stored.updatedAt);stored={...stored,...body,updatedAt:'2026-09-15T03:01:00Z'};return route.fulfill({json:stored}); }
    if(method==='POST') { stored={...stored,...route.request().postDataJSON(),id:'new-1'};return route.fulfill({json:stored,status:201}); }
    if(url.pathname==='/api/commentaries')return route.fulfill({json:{items:[stored],hasMore:false}});
    return route.fulfill({json:stored});
  });
});
test.afterEach(()=>{expect(errors).toEqual([]);expect(unexpected).toEqual([]);});

test('tracking archive opens, edits, generates and retains source evidence',async({page},testInfo)=>{
  await page.goto('/trading-research/tracking-commentary?id=archive-1');
  await expect(page.getByLabel('主题',{exact:true})).toHaveValue(original.eventName);
  await expect(page.getByText('时事快评.docx',{exact:true})).toBeAttached();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('tracking-commentary.png');
  await page.getByLabel('应对建议',{exact:true}).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('应对建议',{exact:true})).toBeInViewport();
  await expect(page.locator('.tr-workspace')).toHaveScreenshot('tracking-commentary-editor.png');
  await page.getByLabel('跟踪点评',{exact:true}).fill('人工修改后的点评正文');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByText('点评已保存',{exact:true})).toBeVisible();
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'检索并生成',exact:true}).click();
  await expect(page.getByLabel('跟踪点评',{exact:true})).toHaveValue(stored.commentary);
  await expect(page.getByRole('heading',{name:'取材原句'})).toBeVisible();
  await expect(page.getByText('融资窗口分析',{exact:true})).toBeVisible();
  await closeAiSurfaces(page);
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'保存 PDF',exact:true}).click();
  await (await downloaded).saveAs(testInfo.outputPath('tracking-commentary-saved.pdf'));
  await expect(page.getByRole('link',{name:'下载 PDF',exact:true})).toHaveAttribute('href',`/api/commentaries/archive-1/pdf?revisionAt=${encodeURIComponent(stored.updatedAt)}`);
  await page.getByRole('button',{name:'版本记录',exact:true}).click();
  await expect(page.getByRole('button',{name:/2026-09-15 03:00:00/})).toBeVisible();
});

test('failed saves retain the edited draft',async({page})=>{
  await page.goto('/trading-research/tracking-commentary?id=archive-1');
  await expect(page.getByLabel('主题',{exact:true})).toHaveValue(original.eventName);
  await page.route('**/api/commentaries/archive-1',async route=>route.request().method()==='PUT' ? route.fulfill({status:409,json:{error:'点评已更新，请重新打开后编辑'}}):route.fallback());
  await page.getByLabel('事件摘要',{exact:true}).fill('保留这段尚未保存的内容');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByText('点评已更新，请重新打开后编辑',{exact:true})).toBeVisible();
  await expect(page.getByLabel('事件摘要',{exact:true})).toHaveValue('保留这段尚未保存的内容');
  await expect(page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();
});


test('manual edits autosave and print isolates the A4 report',async({page},testInfo)=>{
  await page.goto('/trading-research/tracking-commentary?id=archive-1');
  await expect(page.getByLabel('主题',{exact:true})).toHaveValue(original.eventName);
  await page.getByLabel('事件摘要',{exact:true}).fill('自动同步到数据库的人工修订摘要');
  await expect.poll(()=>stored.eventSummary).toBe('自动同步到数据库的人工修订摘要');
  await expect(page.getByText('已保存',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
  await page.getByRole('button',{name:'打印',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__printed)).toBe(true);
  await page.emulateMedia({media:'print'});
  await expect(page.locator('.tracking-print-host')).toBeVisible();
  await expect(page.locator('.tracking-workspace')).not.toBeVisible();
  await expect(page).toHaveScreenshot('tracking-commentary-print.png',{fullPage:true});
  await page.pdf({format:'A4',preferCSSPageSize:true,printBackground:true,path:testInfo.outputPath('tracking-commentary-native-print.pdf')});
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({media:'screen'});
  await expect(page.getByLabel('主题',{exact:true})).toBeVisible();
});


test('long commentary produces multiple A4 PDF pages',async({page},testInfo)=>{
  await page.goto('/trading-research/tracking-commentary?id=archive-1');
  await expect(page.getByLabel('主题',{exact:true})).toHaveValue(original.eventName);
  await page.getByLabel('跟踪点评',{exact:true}).fill(Array.from({length:12},(_,i)=>`${i+1}. 第${i+1}段判断\n资金需求回落，融资成本下移，发行窗口具备有利条件。`.repeat(4)).join('\n\n'));
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'保存 PDF',exact:true}).click();
  await (await downloaded).saveAs(testInfo.outputPath('tracking-commentary-long.pdf'));
  expect(pdfBytes.toString('latin1')).toMatch(/\/Count [2-9]/);
});
