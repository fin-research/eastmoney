import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx/xlsx.mjs';
import { parseDebtWorkbookData } from '../../scripts/financing/lib/excel-import.mjs';
import { transformWorkbook } from '../../scripts/financing/lib/debt-transform.mjs';
import { validateWorkbook, validateIncrement, incrementForIndex, balanceKey } from '../../src/lib/financing/debt-import-json.ts';

function workbookFixture() {
	const workbook = XLSX.utils.book_new();
	const summaryRows = [
		[],
		[],
		['品种', '2026-09-03'],
		['收益凭证', 1],
		['收益权转让', 2],
		['同业拆借', 3],
		['次级债', 4],
		['集团借款', 5],
		['转融资', 6],
		['短期融资券', 7],
		['私募债', 8],
		['小公募', 9],
		['互换便利', 10],
		['合计', 55]
	];
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), '借入资金汇总表');
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
		['名称', '借款对象', '借入金额', '起息日', '到期日', '利率'],
		['测试集团借款', '集团公司', 100000000, '2026-09-01', '2027-09-01', '2.1%']
	]), '集团借款');
	return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}

test('uploaded workbook is parsed and transformed directly without persisting the raw file', () => {
	const transformed = transformWorkbook(parseDebtWorkbookData(
		workbookFixture(),
		'东方财富证券借入资金汇总表20260903.xlsx'
	));
	assert.equal(transformed.snapshot.asOfDate, '2026-09-03');
	assert.equal(transformed.snapshot.totalYi, 55);
	assert.equal(transformed.debts.length, 1);
	assert.equal(transformed.debts[0].debtType, '集团借款');
	assert.equal(transformed.debts[0].amount, 100000000);
	assert.equal(transformed.debts[0].annualRate, 0.021);
	assert.equal(transformed.balances.length, 10);
});

test('JSON workbook validation preserves rows and rejects invalid dates, money, or orphan cashflows', () => {
 const transformed=transformWorkbook(parseDebtWorkbookData(workbookFixture(),'借入资金汇总表20260903.xlsx'));
 const parsed=validateWorkbook(JSON.parse(JSON.stringify(transformed)));
 assert.equal(parsed.debts.length,1);assert.equal(parsed.balances.length,10);
 assert.throws(()=>validateWorkbook({...transformed,debts:[{...transformed.debts[0],issueDate:'2026-02-30'}]}));
 assert.throws(()=>validateWorkbook({...transformed,debts:[{...transformed.debts[0],amount:-1}]}));
 assert.throws(()=>validateWorkbook({...transformed,cashflows:[{sourceKey:'missing',cashflowType:'principal',dueDate:'2026-09-03',amount:1}]}),/没有对应新增负债/);
 assert.throws(()=>validateIncrement({...parsed,snapshot:{...parsed.snapshot,totalYi:99}}),/余额分项/);
});

test('Excel import refuses a malformed sheet or cashflow instead of silently dropping it',()=>{
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['无效表头'],['不能丢弃的数据']]),'同业拆借');
 assert.throws(()=>parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx'),/无法识别表头/);
 delete workbook.Sheets['同业拆借'];workbook.SheetNames.pop();
 workbook.Sheets['集团借款']=XLSX.utils.aoa_to_sheet([['名称','借款对象','借入金额','起息日','到期日','应付利息'],['测试','集团公司',100,'2026-09-01',null,1]]);
 assert.throws(()=>parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx'),/缺少有效日期/);
});


test('derived movement summary is allowed but a business row without money is refused',()=>{
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['起息','到期','变化']]),'变动');
 const read=()=>parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx');
 assert.equal(transformWorkbook(read()).debts.length,1);
 workbook.Sheets['集团借款']=XLSX.utils.aoa_to_sheet([['名称','借款对象','借入金额','起息日','到期日'],['测试','集团公司',null,'2026-09-01','2027-09-01']]);
 assert.throws(()=>transformWorkbook(read()),/缺少金额/);
});

test('text in swap repo average balance is retained as a description and reported without blocking import', () => {
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 const description='滚动续作，隔夜和7天为主，余额每日波动，互换到期后统计日均余额';
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
  ['互换开始日','互换规模（元）','正回购日均余额（元）','互换到期日'],
  ['2026-09-01',2000000000,description,'2027-09-01']
 ]),'互换便利');
 const parsed=parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx');
 const transformed=validateWorkbook(transformWorkbook(parsed));
 const swap=transformed.debts.find(debt=>debt.debtType==='互换便利');
 assert.equal(swap?.amount,2000000000);
 assert.equal(swap?.extension.averageRepoBalanceDescription,description);
 assert.match(parsed.warnings[0],/互换便利 第 2 行.*跳过数值校验/);
 assert.equal(parsed.warnings.length,1);
});

test('a genuine outstanding balance column still rejects text', () => {
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 workbook.Sheets['集团借款']=XLSX.utils.aoa_to_sheet([
  ['名称','借款对象','借入金额','余额','起息日','到期日'],
  ['测试集团借款','集团公司',100000000,'滚动续作','2026-09-01','2027-09-01']
 ]);
 assert.throws(()=>parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx'),/余额 无效/);
});

test('failed issues and recognized narrative rows are skipped with counts', () => {
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
  ['名称','发行状态','清盘金额','发行日期'],
  ['未发行产品','发行失败','-', '2026-09-01']
 ]),'收益凭证');
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
  ['债券简称','发行金额','发行日期'],
  ['发行阶段：说明',null,null],
  ['1、办理手续',null,null]
 ]),'小公募');
 const parsed=parseDebtWorkbookData(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'借入资金汇总表20260903.xlsx');
 const transformed=validateWorkbook(transformWorkbook(parsed));
 assert.equal(transformed.debts.length,1);
 assert.equal(parsed.skipped,3);
 assert.deepEqual(parsed.warnings,[
  '已跳过 1 条发行失败且无金额的收益凭证记录',
  '已跳过 2 行债券及集团借款说明文字'
 ]);
});


test('browser compares the downloaded index and uploads only candidate additions',()=>{
 const workbook=validateWorkbook(transformWorkbook(parseDebtWorkbookData(workbookFixture(),'借入资金汇总表20260903.xlsx')));
 const old=workbook.debts[0];
 const newDebt={...old,sourceKey:'new-debt',name:'新增借款',amount:20};
 const parsed=validateWorkbook({...workbook,debts:[old,newDebt],cashflows:[{sourceKey:old.sourceKey,cashflowType:'principal',dueDate:'2026-09-03',amount:100},{sourceKey:newDebt.sourceKey,cashflowType:'principal',dueDate:'2026-09-03',amount:20}]});
 const index={version:'verified',debts:[old],balanceKeys:parsed.balances.map(balanceKey)};
 const increment=incrementForIndex(parsed,index);
 assert.deepEqual(increment.debts,[newDebt]);assert.equal('identities' in increment,false);
 assert.deepEqual(increment.cashflows.map(c=>c.sourceKey),['new-debt']);assert.equal(increment.balances.length,0);
 assert.equal(increment.snapshotBalances.length,10);
 assert.throws(()=>incrementForIndex(parsed,{...index,version:''}));
 const corrected={...old,sourceKey:'corrected',maturityDate:'2027-09-02'};
 const related=validateWorkbook({...parsed,debts:[old,corrected],cashflows:[]});
 assert.deepEqual(incrementForIndex(related,index).debts.map(d=>d.sourceKey),[old.sourceKey,'corrected']);
 const swap={...old,sourceKey:'swap',table:'swap_facility',debtType:'互换便利',name:'互换便利·2026-09-01',legacyName:'互换便利·2026-09-01',subtype:null};
 const withSwap=validateWorkbook({...parsed,debts:[old,swap],cashflows:[]});
 assert.deepEqual(incrementForIndex(withSwap,{...index,debts:[old,swap]}).debts,[]);
 assert.deepEqual(incrementForIndex(withSwap,{...index,debts:[old,{...swap,issueDate:'2026-08-31'}]}).debts.map(d=>d.sourceKey),['swap']);
});

test('narrative sections with zero placeholders and duplicate cells cannot become debts or steal cashflows',()=>{
 const workbook=XLSX.read(workbookFixture(),{type:'array'});
 const serialize=()=>XLSX.write(workbook,{type:'array',bookType:'xlsx'});
 for(const sheet of ['小公募','次级债','私募债','科创债','短期融资券','公司债']){
  workbook.Sheets[sheet]=XLSX.utils.aoa_to_sheet([
   ['债券简称','发行金额','发行日期','到期日','备注'],
   ['1、真实债券',1000,'2026-09-01','2027-09-01'],
   ['发行阶段：说明',0,null,null,'发行阶段：说明'],
   ['4、兑付日前办理手续','-',null,null]
  ]);
  if(!workbook.SheetNames.includes(sheet))workbook.SheetNames.push(sheet);
 }
 const parsed=parseDebtWorkbookData(serialize(),'借入资金汇总表20260903.xlsx');
 const transformed=validateWorkbook(transformWorkbook(parsed));
 assert.equal(transformed.debts.length,7);assert.equal(parsed.skipped,12);
 assert.ok(transformed.debts.filter(d=>d.debtType==='债券').every(d=>d.amount===1000));
 workbook.Sheets['小公募']=XLSX.utils.aoa_to_sheet([
  ['债券简称','发行金额','发行日期','到期日','应付利息','付息时间'],
  ['真实债券',1000,'2026-09-01','2027-09-01'],
  ['发行阶段：说明',0],
  [null,null,null,null,10,'2027-09-01']
 ]);
 assert.throws(()=>parseDebtWorkbookData(serialize(),'借入资金汇总表20260903.xlsx'),/无法关联负债/);
});

test('direct import increments reject undated narrative debt but preserve legitimate zero balance history',()=>{
 const transformed=validateWorkbook(transformWorkbook(parseDebtWorkbookData(workbookFixture(),'借入资金汇总表20260903.xlsx')));
 const debt={...transformed.debts[0],table:'bond',debtType:'债券',subtype:'小公募',name:'3、兑付日当日完成向投资人投资本息兑付。',amount:0,interestPayable:0,annualRate:null,counterparty:null,issueDate:null,maturityDate:null,activatedAt:null,settledAt:null,closedAt:null};
 assert.throws(()=>validateIncrement({...transformed,debts:[debt]}),/说明文字不能作为负债/);
 assert.doesNotThrow(()=>validateIncrement({...transformed,debts:[{...debt,name:'1、计划产品',extension:{bookbuildingDate:'2026-10-20'}}]}));
 assert.doesNotThrow(()=>validateIncrement({...transformed,debts:[{...debt,extension:{bookbuildingDate:'2026-10-20'}}]}));
 assert.doesNotThrow(()=>validateIncrement({...transformed,debts:[{...debt,name:'历史债券',issueDate:'2020-01-01',maturityDate:'2021-01-01'}]}));
});
