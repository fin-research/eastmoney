import {test,expect} from '@playwright/test';
import ExcelJS from 'exceljs';
import {mockResources} from './fixtures.mjs';

test('financing debt table and shared editor support filtered CRUD and Excel export',async({page})=>{
 await mockResources(page);
 await page.clock.setFixedTime(new Date('2026-10-16T15:59:00Z'));
 let rows=[{id:1,name:'示例收益凭证',subtype:'固定收益凭证',debt_type:'收益凭证',counterparty:'示例银行',amount:100000000,annual_rate:.021,issue_date:'2026-10-01',maturity_date:'2030-10-01',activated_at:'2026-10-01',status:'active',updated_at:'2026-10-16T01:00:00Z'}];
 const reads=[],writes=[];
 await page.route('**/financing/data/token',route=>route.fulfill({json:{token:'fixture',dataApiUrl:'https://debt-fixture.invalid'}}));
 await page.route('https://debt-fixture.invalid/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(req.method()==='GET'){
   reads.push(url);let result=rows;
   const id=url.searchParams.get('id');if(id)result=result.filter(r=>String(r.id)===id.slice(3));
   const search=url.searchParams.get('or');if(search?.includes('无匹配'))result=[];
   await route.fulfill({json:result,headers:{'access-control-expose-headers':'content-range','content-range':`0-${result.length}/${result.length}`}});
  }else{
   writes.push({method:req.method(),url,body:req.postDataJSON()});
   if(req.method()==='POST'){const row={...req.postDataJSON(),id:2,status:'planned',updated_at:'2026-10-16T02:00:00Z'};rows.push(row);await route.fulfill({json:[row]});}
   else if(req.method()==='PATCH'){rows=rows.map(r=>r.id===1?{...r,...req.postDataJSON(),updated_at:'2026-10-16T03:00:00Z'}:r);await route.fulfill({json:[rows[0]]});}
   else{const deleted=rows.filter(r=>String(r.id)===url.searchParams.get('id')?.slice(3));rows=rows.filter(r=>!deleted.includes(r));await route.fulfill({json:deleted});}
  }
 });
 await page.goto('/financing/data?tab=debt-0');
 await expect(page.getByRole('link',{name:'示例收益凭证',exact:true})).toBeVisible();
 expect(reads.at(-1).searchParams.get('lifecycle')).toBe('unmatured');expect(reads.at(-1).searchParams.get('order')).toBe('issue_date.desc.nullslast,id.desc.nullslast');
 expect(reads.at(-1).searchParams.get('as_of')).toBe('2026-10-16');
 await page.clock.setFixedTime(new Date('2026-10-16T16:01:00Z'));await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>reads.at(-1)?.searchParams.get('as_of')).toBe('2026-10-17');await expect(page.getByRole('link',{name:'示例收益凭证',exact:true})).toBeVisible();
 for(const name of ['科创债','私募债','收益权转让','互换便利']) await expect(page.getByRole('link',{name,exact:true})).toHaveCount(0);
 await expect(page.locator('.tr-workbench')).toHaveScreenshot('financing-debt-table.png');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('combobox',{name:'到期筛选'}).selectOption('all');
 await expect(page.getByRole('link',{name:'示例收益凭证',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'本金（元）列菜单',exact:true}).click();await expect(page.getByRole('button',{name:'升序',exact:true})).toBeVisible();await expect(page.locator('.tr-workbench')).toHaveScreenshot('financing-debt-menu.png');await page.getByRole('button',{name:'降序',exact:true}).click();
 await expect(page).toHaveURL(/sort=amount/);
 await page.getByRole('button',{name:'交易对手列菜单',exact:true}).click();await page.getByRole('textbox',{name:'交易对手筛选值'}).fill('示例');await page.getByRole('button',{name:'应用',exact:true}).click();await expect(page).toHaveURL(/f_counterparty=/);
 await page.getByRole('button',{name:'交易对手列菜单',exact:true}).click();await page.getByRole('button',{name:'隐藏列',exact:true}).click();await expect(page.getByRole('button',{name:'交易对手列菜单',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByText('交易对手',{exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'交易对手列菜单',exact:true})).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索负债'}).fill('无匹配');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.getByText('暂无记录', {exact:true})).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索负债'}).fill('');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.getByRole('link',{name:'示例收益凭证',exact:true})).toBeVisible();
 await page.locator('.debt-row').click();await expect(page.getByRole('textbox',{name:'负债简称',exact:true})).toHaveValue('示例收益凭证');
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-debt-edit.png');
 await page.getByRole('textbox',{name:'负债简称',exact:true}).fill('修订收益凭证');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('link',{name:'修订收益凭证',exact:true})).toBeVisible();
 expect(writes[0].url.searchParams.get('updated_at')).toBe('eq.2026-10-16T01:00:00Z');await expect(page).toHaveURL(/sort=amount/);
 await page.getByRole('link',{name:'新增条目',exact:true}).click();await expect(page.getByRole('heading',{name:'新增收益凭证'})).toBeVisible();
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('financing-debt-new.png');
 await page.getByRole('textbox',{name:'负债简称',exact:true}).fill('新增凭证');await page.getByRole('spinbutton',{name:'本金（元）',exact:true}).fill('200000');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('link',{name:'新增凭证',exact:true})).toBeVisible();
 const before=reads.length;const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 Excel',exact:true}).click();const file=await download;expect(reads.length).toBeGreaterThan(before);expect(reads.at(-1).searchParams.get('limit')).toBe('500');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(await file.path());expect(workbook.worksheets[0].rowCount).toBe(3);
 await page.getByRole('link',{name:'新增凭证',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除条目',exact:true}).click();await expect(page.getByRole('combobox',{name:'到期筛选'})).toBeVisible();await expect(page.getByRole('link',{name:'新增凭证',exact:true})).toHaveCount(0);expect(writes.at(-1).method).toBe('DELETE');
 await page.reload();await expect(page.getByRole('combobox',{name:'到期筛选'})).toHaveValue('all');
});

test('debt editor preserves failed inputs and hides independent write permissions',async({page})=>{
 await mockResources(page);
 const row={id:1,name:'保留输入凭证',subtype:'固定收益凭证',amount:10,annual_rate:.02,updated_at:'2026-10-16T01:00:00Z'};
 await page.route('**/financing/data/token',route=>route.fulfill({json:{token:'fixture',dataApiUrl:'https://debt-fixture.invalid'}}));
 await page.route('https://debt-fixture.invalid/**',route=>route.request().method()==='GET'?route.fulfill({json:[row],headers:{'access-control-expose-headers':'content-range','content-range':'0-0/1'}}):route.fulfill({status:409,json:{message:'记录已被其他人修改，请刷新后重试'}}));
 await page.goto('/financing/data?tab=debt-0&entry=1');
 const name=page.getByRole('textbox',{name:'负债简称',exact:true});await expect(name).toHaveValue(row.name);await name.fill('失败后保留');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByText('记录已被其他人修改，请刷新后重试',{exact:true})).toBeVisible();await expect(name).toHaveValue('失败后保留');
 await page.goto('/financing/data?tab=debt-0&debtReadOnly=1');await expect(page.getByRole('link',{name:'保留输入凭证',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'新增条目',exact:true})).toHaveCount(0);
 await page.getByRole('link',{name:'保留输入凭证',exact:true}).click();await expect(name).toBeDisabled();await expect(page.getByRole('button',{name:'保存',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'删除条目',exact:true})).toHaveCount(0);
});

test('debt table ignores stale reads and clamps a deleted last page',async({page})=>{
 await mockResources(page);
 const row={id:1,name:'最新结果凭证',subtype:'固定收益凭证',amount:10,status:'active',updated_at:'2026-10-16T01:00:00Z'};
 let dataset=[row];
 let release;const delayed=new Promise(resolve=>release=resolve);let staleRequested=false;
 await page.route('**/financing/data/token',route=>route.fulfill({json:{token:'fixture',dataApiUrl:'https://debt-fixture.invalid'}}));
 await page.route('https://debt-fixture.invalid/**',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('or')?.includes('慢请求')){staleRequested=true;await delayed;await route.fulfill({json:[{...row,name:'过时结果凭证'}],headers:{'access-control-expose-headers':'content-range','content-range':'0-0/1'}});return;}
  if(route.request().method()==='DELETE') {const deleted=dataset.filter(item=>String(item.id)===url.searchParams.get('id')?.slice(3));dataset=dataset.filter(item=>!deleted.includes(item));await route.fulfill({json:deleted});return;}
  const id=url.searchParams.get('id');
  const result=id?dataset.filter(item=>String(item.id)===id.slice(3)):dataset.slice(Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('offset')??0)+Number(url.searchParams.get('limit')??50));
  await route.fulfill({json:result,headers:{'access-control-expose-headers':'content-range','content-range':`0-0/${dataset.length}`}});
 });
 await page.goto('/financing/data?tab=debt-0');await expect(page.getByRole('link',{name:row.name,exact:true})).toBeVisible();
 await page.getByRole('searchbox',{name:'搜索负债'}).fill('慢请求');await page.getByRole('button',{name:'查询',exact:true}).click();await expect.poll(()=>staleRequested).toBe(true);
 await page.getByRole('searchbox',{name:'搜索负债'}).fill('最新');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.getByRole('link',{name:row.name,exact:true})).toBeVisible();const staleResponse=page.waitForResponse(response=>response.url().includes('debt-fixture.invalid')&&response.url().includes('%E6%85%A2'));release();await staleResponse;await expect(page.getByRole('link',{name:'过时结果凭证',exact:true})).toHaveCount(0);
 dataset=Array.from({length:51},(_,index)=>({...row,id:index+1,name:`分页凭证${index+1}`}));
 await page.goto('/financing/data?tab=debt-0&page=1');await page.getByRole('link',{name:'分页凭证51',exact:true}).click();await expect(page.getByRole('textbox',{name:'负债简称',exact:true})).toHaveValue('分页凭证51');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'删除条目',exact:true}).click();await expect(page).not.toHaveURL(/page=1/);await expect(page.getByText('第 1 / 1 页',{exact:true})).toBeVisible();
});
