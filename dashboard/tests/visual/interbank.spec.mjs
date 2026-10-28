import {test,expect} from '@playwright/test';
import * as XLSX from 'xlsx';
import {zipSync,strToU8} from 'fflate';
import {mockResources} from './fixtures.mjs';
test.beforeEach(async({page})=>{await page.clock.setFixedTime(new Date('2026-10-16T02:00:00Z'));page.on('pageerror',error=>{throw error;});page.on('crash',()=>console.error('interbank browser page crashed'));});
function fixture(){
 const serial='IBO20261016000001',book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
 ['成交编号','成交日期','本方方向','本方','对手方','本方资金账号','对手方资金账号','拆借金额(万)','拆借利率(%)','实际占款天数','拆借期限(天)','拆借利息','到期还款金额','首次结算日','到期还款日'],
 [serial,'2026-10-16','拆入','东方财富证券','上海农村商业银行股份有限公司','000123','000456','10000','1.8250001','3','7','1520.833','100001520.833','2026-10-16','2026-10-19']]),'信用拆借成交');
 const text=`BT /F1 12 Tf 50 700 Td (${serial}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
 let pdf='%PDF-1.4\n',offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const start=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return Buffer.from(zipSync({'成交查询.xlsx':new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'})),'成交单.pdf':strToU8(pdf)}));
}
async function directoryPicker(page){
 await page.addInitScript(({native})=>{
  window.pickerCalls=0;
  async function nativeDirectory(path){
   let root=await navigator.storage.getDirectory();
   for(const part of path.split('/').filter(Boolean))root=await root.getDirectoryHandle(part,{create:true});
   return root;
  }
  // Pinned Linux Chromium SIGTRAPs even in a standalone native OPFS→IDB read.
  // Native macOS Chrome runs this same suite without the descriptor adapter.
  class DirectoryFixture{
   constructor(name,path){this.fixture=true;this.name=name;this.path=path;}
   async queryPermission(){return 'granted';}
   async requestPermission(){return 'granted';}
   async getDirectoryHandle(name,options){await (await nativeDirectory(this.path)).getDirectoryHandle(name,options);return new DirectoryFixture(name,this.path+'/'+name);}
   async getFileHandle(name,options){return (await nativeDirectory(this.path)).getFileHandle(name,options);}
  }
  if(!native){
   window.DirectoryFixture=DirectoryFixture;
   const get=IDBObjectStore.prototype.get;
   IDBObjectStore.prototype.get=function(key){
    const request=get.call(this,key);
    if(this.transaction.db.name==='eastmoney-interbank' && this.name==='directory' && key==='archive-root')request.addEventListener('success',()=>{
     if(request.result?.fixture===true)Object.setPrototypeOf(request.result,DirectoryFixture.prototype);
    });
    return request;
   };
  }
  Object.defineProperty(window,'showDirectoryPicker',{value:async()=>{
   window.pickerCalls++;
   const handle=await nativeDirectory('交易');
   return native?handle:new DirectoryFixture('交易','交易');
  },configurable:true});
 },{native:process.platform==='darwin'});
}
const zipFile=()=>({name:'成交.zip',mimeType:'application/zip',buffer:fixture()});
async function mockCamel(page,{pause=false,uploadFailure=false}={}){
 let imported=false,hid=null,release;
 const gate=new Promise(resolve=>release=resolve),writes=[];
 await page.route('**/api/interbank/**',()=>{throw Error('Dashboard proxy must not be called');});
 await page.route('**/data/camel/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/data/camel','');
  let json;
  if(request.method()==='POST')writes.push(path);
  if(path==='/borrowings'){
   if(pause){pause=false;await gate;}
   json={records:imported?[{id:12,serialNo:'IBO20261016000001',busiDate:'2026-10-16',counterpartyName:'上海农村商业银行股份有限公司',matchAmount:'100000000',matchTime:'2026-10-16',firstSettleDate:'2026-10-19',expireAmount:'100001520.833',financingCode:'F12',hid}]:[],total:imported?1:0};
  }
  else if(path==='/borrowings/parse')json={status:'SUCCESS',totalNum:1,data:[{serialNo:'IBO20261016000001',counterpartyId:'bank'}]};
  else if(path==='/borrowings/import'){const record=request.postDataJSON().records[0];expect(record.ourpartyAccount).toBe('000123');expect(record.days).toBe('3');expect(record.daysPurpose).toBe('7');imported=true;json={saved:true};}
  else if(path==='/attachments'){
   if(uploadFailure){await route.fulfill({status:503,json:{detail:'上传结果未知'}});return;}
   expect(request.headers()['content-type']).toBe('application/pdf');expect(decodeURIComponent(request.headers()['x-filename'])).toBe('1016 上海农 1E 成交单.pdf');json={id:'file1'};
  }
  else if(path==='/repayment-drafts'){hid=9;json={hid};}
  else if(path==='/repayment-drafts/9')json={hid:9,reservationId:'F12',remark:'IBO20261016000001',reviewStatus:'0',status:'0',repaymentId:12,attachmentList:[{id:'file1'}]};
  else throw Error('unexpected '+path);
  await route.fulfill({json});
 });
 return {writes,release};
}
async function ready(page){
 await page.goto('/trading-research/interbank-ledger');
 await expect(page.getByRole('button',{name:'选择归档目录',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'选择归档目录',exact:true}).click();
 await expect(page.getByRole('button',{name:'交易',exact:true})).toBeEnabled();
}
async function complete(page){
 await expect(page.getByRole('region',{name:'成交处理进度'})).toContainText('已上传');
 await expect(page.getByRole('region',{name:'成交处理进度'})).toContainText('已导入');
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
}
async function dropZip(page){
 const buffer=[...fixture()];
 const transfer=await page.evaluateHandle(bytes=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'成交.zip',{type:'application/zip'}));return data;},buffer);
 await page.getByRole('region',{name:'成交压缩包拖放区'}).dispatchEvent('drop',{dataTransfer:transfer});
}
test('interbank archive previews renamed files and saves only repayment drafts',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page,{pause:true});
 await ready(page);
 await expect(page.getByRole('link',{name:'拆借台账',exact:true})).toHaveAttribute('aria-current','page');
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('interbank-empty.png');
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('button',{name:'导入中',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'归档文件预览'})).toContainText('1016 上海农 1E 成交单.pdf');
 await page.mouse.move(0,0);
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('interbank-preview.png');
 service.release();await complete(page);
 await page.mouse.move(0,0);await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
 await expect(page.locator('.tr-workspace')).toHaveScreenshot('interbank-complete.png');
 expect(service.writes).toEqual(['/borrowings/parse','/borrowings/import','/attachments','/repayment-drafts']);
});

test('interbank directory archive writes renamed files beneath the trade date',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page);
 await ready(page);await dropZip(page);await complete(page);
 const files=await page.evaluate(async()=>{
  const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('交易');
  const directory=await root.getDirectoryHandle('2026-10-16');const files=[];
  for await(const [name,handle]of directory.entries())files.push([name,(await handle.getFile()).size]);
  return files;
 });
 expect(files.map(([name])=>name).sort()).toEqual(['1016 上海农 1E 成交单.pdf','信用拆借成交查询_20261016.xlsx']);
 expect(files.every(([,size])=>size>0)).toBe(true);
 await page.reload();await expect(page.getByRole('button',{name:'交易',exact:true})).toBeEnabled();
 await dropZip(page);await complete(page);
 expect(await page.evaluate(()=>window.pickerCalls)).toBe(0);
 expect(service.writes.filter(path=>path==='/borrowings/import')).toHaveLength(1);
 expect(service.writes.filter(path=>path==='/attachments')).toHaveLength(1);
 expect(service.writes.filter(path=>path==='/repayment-drafts')).toHaveLength(1);
});

test('automatic archive reads current progress under the shared account lock',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page);
 await ready(page);
 await page.evaluate(async()=>{
  let started;const ready=new Promise(resolve=>started=resolve);
  window.otherTabLock=navigator.locks.request('interbank:auth0|test',async()=>{started();await new Promise(resolve=>window.releaseOtherTab=resolve);});await ready;
 });
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
 expect(service.writes).toEqual([]);
 await page.evaluate(()=>window.releaseOtherTab());
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());await complete(page);
 expect(service.writes.filter(path=>path==='/borrowings/import')).toHaveLength(1);
});

test('archive collision prevents all funding requests',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page);
 await ready(page);
 await page.evaluate(async()=>{
  const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('交易');
  const dir=await root.getDirectoryHandle('2026-10-16',{create:true});
  const file=await dir.getFileHandle('信用拆借成交查询_20261016.xlsx',{create:true});
  const stream=await file.createWritable();await stream.write('different');await stream.close();
 });
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
 await expect(page.getByRole('region',{name:'成交处理进度'})).toContainText('待保存');
 expect(service.writes).toEqual([]);
});

test('unknown upload stops automatic retry on repeated ZIP selection',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page,{uploadFailure:true});
 await ready(page);await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('region',{name:'成交处理进度'})).toContainText('结果待确认');
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
 expect(service.writes.filter(path=>path==='/attachments')).toHaveLength(1);
 expect(service.writes.filter(path=>path==='/repayment-drafts')).toHaveLength(0);
});

test('directory permission recovery automatically resumes the selected archive',async({page})=>{
 await mockResources(page);await directoryPicker(page);const service=await mockCamel(page);
 await ready(page);
 await page.evaluate(()=>{
  Object.defineProperty((window.DirectoryFixture?.prototype??FileSystemHandle.prototype),'queryPermission',{value:async()=> 'prompt',configurable:true});
  Object.defineProperty((window.DirectoryFixture?.prototype??FileSystemHandle.prototype),'requestPermission',{value:async()=> 'denied',configurable:true});
 });
 await page.getByLabel('选择成交压缩包').setInputFiles(zipFile());
 await expect(page.getByRole('button',{name:'选择成交压缩包',exact:true})).toBeEnabled();
 expect(service.writes).toEqual([]);
 await page.getByRole('button',{name:'交易',exact:true}).click();await complete(page);
 expect(service.writes.filter(path=>path==='/borrowings/import')).toHaveLength(1);
});
