import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {zipSync,unzipSync,strToU8} from 'fflate';
import {sourceRows,correctedRecords,shiftDecimal,pdfName} from '../src/lib/interbank/model.ts';
import {readExcel,prepareArchive,archiveZip} from '../src/lib/interbank/prepare.ts';
import {runWorkflow,ledgerRows} from '../src/lib/interbank/workflow.ts';
const header=['成交编号','成交日期','本方方向','本方','对手方','本方资金账号','对手方资金账号','拆借金额(万)','拆借利率(%)','实际占款天数','拆借期限(天)','拆借利息','到期还款金额','首次结算日','到期还款日'];
const serial='IBO20261016000001';
const values=[serial,'2026-10-16','拆入','东方财富证券','上海农村商业银行股份有限公司','000123','000456','10000','1.8250001','3','7','1520.833','100001520.833','2026-10-16','2026-10-19'];
const trades=()=>sourceRows([header,values]);
function excel(type='xlsx') {const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([header,values]),'信用拆借成交');return new Uint8Array(XLSX.write(book,{type:'array',bookType:type}));}
function batch() {return {date:'2026-10-16',signature:'batch',excel:'test.xlsx',trades:trades(),files:[{source:'test.xlsx',name:'test.xlsx',bytes:excel(),digest:'excel'},{source:'trade.pdf',name:'trade.pdf',serialNo:serial,bytes:strToU8('%PDF-test'),digest:'pdf'}]};}
const journal=()=>({signature:'batch',archived:true,trades:{},uploads:{}});
const row={id:12,serialNo:serial,busiDate:'2026-10-16',firstSettleDate:'2026-10-19',financingCode:'F12'};
function service({uploadFailure=false,importFailure=false,draftFailure=false}={}) {
 let imported=false,hid=null;const calls=[];
 const api=async(path,init)=>{calls.push([path,init]);if(path.startsWith('/borrowings?'))return {records:imported?[{...row,hid}]:[],total:imported?1:0};if(path==='/borrowings/parse')return {status:'SUCCESS',totalNum:1,data:[{serialNo:serial,counterpartyId:'bank'}]};if(path==='/borrowings/import'){imported=true;if(importFailure)throw Error('network');return {saved:true};}if(path==='/attachments'){if(uploadFailure)throw Error('network');return {id:'file1'};}if(path==='/repayment-drafts'){hid=9;if(draftFailure)throw Error('network');return {hid};}if(path==='/repayment-drafts/9')return {hid,reservationId:'F12',remark:serial,reviewStatus:'0',status:'0',repaymentId:12,attachmentList:[{id:'file1'}]};throw Error(path);};
 return {api,calls};
}
test('duplicate columns choose first complete column and reject conflicts or split values',()=>{
 assert.equal(sourceRows([[...header,'本方资金账号'],[...values,'']])[0]['本方资金账号'],'000123');
 assert.throws(()=>sourceRows([[...header,'本方资金账号'],[...values,'999']]),/重复列冲突/);
 const second=[...values];second[0]='IBO20261016000002';second[5]='';
 assert.throws(()=>sourceRows([[...header,'本方资金账号'],[...values,''],[...second,'000999']]),/分散填值/);
});
test('full worksheet ignores corrupt dimension, preserves account zeroes and source decimals',()=>{
 const zipped=unzipSync(excel());const sheet=Object.keys(zipped).find(p=>p==='xl/worksheets/sheet1.xml');
 zipped[sheet]=strToU8(new TextDecoder().decode(zipped[sheet]).replace(/<dimension ref="[^"]+"\/>/,'<dimension ref="A1:A1"/>'));
 const result=readExcel(zipSync(zipped));assert.equal(result.trades[0].serialNo,serial);assert.equal(result.trades[0]['本方资金账号'],'000123');
 const record=correctedRecords({status:'SUCCESS',totalNum:1,data:[{serialNo:serial,days:'wrong',ourpartyAccount:'bad',counterpartyId:'bank'}]},result.trades)[0];
 assert.equal(record.days,'3');assert.equal(record.daysPurpose,'7');assert.equal(record.ourpartyAccount,'000123');assert.equal(record.totalInterest,'1520.833');assert.equal(record.interestRate,'0.018250001');assert.equal(record.counterpartyId,'bank');
});
test('xls is converted to true xlsx and PDF naming uses Excel amount and date',async()=>{
 const prepared=await prepareArchive(zipSync({'old.xls':excel('biff8'),'trade.pdf':strToU8('%PDF-test')}),async()=>`${serial}\n上海农村商业银行股份有限公司`);
 assert.equal(prepared.excel,'信用拆借成交查询_20261016.xlsx');assert.equal(prepared.files[0].bytes[0],80);assert.equal(prepared.files[0].bytes[1],75);
 assert.equal(prepared.files[1].name,'1016 上海农 1E trade.pdf');assert.ok(unzipSync(archiveZip(prepared))['2026-10-16/'+prepared.files[1].name]);
 assert.equal(shiftDecimal('1.8250001',-2),'0.018250001');
 await assert.rejects(prepareArchive(zipSync({'a.xlsx':excel(),'trade.pdf':strToU8('%PDF-test')}),async()=>''),/编号无法确定/);
});
test('durable intent precedes import, upload and draft; one draft readback, no submit',async()=>{
 const state=journal(),s=service();const snapshots=[];
 await runWorkflow(batch(),state,async(path,init)=>{
  if(path==='/borrowings/import')assert.equal(snapshots.at(-1).trades[serial].import,'intent');
  if(path==='/attachments')assert.equal(snapshots.at(-1).uploads['trade.pdf'].status,'intent');
  if(path==='/repayment-drafts')assert.equal(snapshots.at(-1).trades[serial].draft,'intent');
  return s.api(path,init);
 },j=>snapshots.push(structuredClone(j)));
 assert.equal(state.trades[serial].draft,'verified');assert.equal(s.calls.filter(([p])=>p==='/repayment-drafts/9').length,1);assert.ok(s.calls.every(([p])=>!p.includes('submit')));
});
test('unknown import and draft results recover via ledger; no duplicate mutation',async()=>{
 for(const mode of ['importFailure','draftFailure']){
  const state=journal(),s=service({[mode]:true});await assert.rejects(runWorkflow(batch(),state,s.api,()=>{}),/network/);
  await runWorkflow(batch(),state,s.api,()=>{});
  assert.equal(state.trades[serial].draft,'verified');assert.equal(s.calls.filter(([p])=>p==='/borrowings/import').length,1);assert.equal(s.calls.filter(([p])=>p==='/repayment-drafts').length,1);
 }
});
test('unknown attachment upload stops without retry and failed persistence prevents mutation',async()=>{
 const state=journal(),s=service({uploadFailure:true});await assert.rejects(runWorkflow(batch(),state,s.api,()=>{}),/network/);
 await assert.rejects(runWorkflow(batch(),state,s.api,()=>{}),/上传结果未知/);assert.equal(s.calls.filter(([p])=>p==='/attachments').length,1);
 const denied=service();await assert.rejects(runWorkflow(batch(),journal(),denied.api,()=>{throw Error('disk full');}),/disk full/);assert.ok(denied.calls.every(([p])=>p.startsWith('/borrowings?')));
});

test('ledger pagination rejects shifting totals, duplicate or empty IDs and extra rows',async()=>{
 for(const pages of [
  [{records:[row],total:2},{records:[{...row,id:13,serialNo:'IBO20261016000002'}],total:3}],
  [{records:[row,{...row,serialNo:'IBO20261016000002'}],total:2}],
  [{records:[{...row,id:''}],total:1}],
  [{records:[row],total:0}],
 ]){let current=0;await assert.rejects(ledgerRows(async()=>pages[current++],'2026-10-16'),/台账/);}
});

test('xlsx archive preserves original bytes',async()=>{
 const original=excel();
 const result=await prepareArchive(zipSync({'original.xlsx':original,'trade.pdf':strToU8('%PDF-test')}),async()=>serial);
 assert.deepEqual([...result.files.find(file=>file.source==='original.xlsx').bytes],[...original]);assert.doesNotThrow(()=>structuredClone(result));
});
