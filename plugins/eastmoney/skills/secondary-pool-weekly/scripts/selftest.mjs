import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {prepare,render,selectRange,unwrap,main} from './report.mjs';

export function fixture() {
  const performance=Array.from({length:5},(_,i)=>({date:`2026-10-${19+i}`,principal:1e8,timeWeightedPrincipal:1e8,marketValue:1.2e8,leverage:1.2,modifiedDuration:1.1,dailyRevenue:1e5,cumulativeProfit:2e6+i*1e5,ytdAnnualizedReturn:0.99,ytdExTaxAnnualizedReturn:0.98}));
  const operating=performance.map(p=>({...p,tradingMarketValue:8e7,availableMarketValue:4e7,flatStatic:2.5,dv01:10000,cumulativeTaxExemptProfit:3e5,cumulativeExTaxProfit:p.cumulativeProfit-3e5,fullPoolYtdAnnualizedReturn:0.03,fullPoolYtdExTaxAnnualizedReturn:0.026}));
  const report={hasData:true,currentPerformance:performance.at(-1),performanceTrend:performance,operatingTrend:operating,
    accountPerformanceTrends:{trading:[],available:[]},holdingTypes:[],maturityBuckets:[],
    tradingHoldingTypes:[{category:'同业存单',marketValue:8e7,share:1,weightedYield:2.5,weightedRemainingYears:0.5,dv01:6000,dailyProfit:70000,ytdProfit:1e6,positionCount:1}],
    tradingMaturityBuckets:['1月以内','1-3月','3-6月','6-9月','9-12月','1-3年','3-5年','5年以上'].map((bucket,i)=>({bucket,marketValue:i===2?8e7:0,share:i===2?1:0,weightedYield:i===2?2.5:null,positionCount:i===2?1:0})),
    topTradingPositions:[{name:'示例存单',category:'同业存单',remainingYears:0.5,marketValue:8e7,reportYield:2.5}],transactions:[],transactionTotals:{买入:0,卖出:0,到期:0},rangeProfit:5e5,rangeAnnualizedReturn:0.03,ytdAnnualizedReturn:0.03,
    returnRiskMetrics:{annualizedVolatility:0,maxDrawdown:0,validDayCount:5,maxDrawdownPeakDate:null,maxDrawdownTroughDate:null},transactionCount:0,metricDeltas:{},detailMarketValue:1.2e8,
    availability:{pledgedQuantity:5e5,availableQuantity:7e5,pledgedMarketValue:5e7,availableMarketValue:7e7,pledgedFaceAmount:5e7,availableFaceAmount:7e7},
    auditChecks:[{key:'scale',label:'市值守恒',pass:true,actual:1.2e8,expected:1.2e8,difference:0,tolerance:1},{key:'leverage',label:'杠杆核算',pass:true,actual:1.2,expected:1.2,difference:0,tolerance:1e-6},{key:'profit',label:'当日损益守恒',pass:true,actual:1e5,expected:1e5,difference:0,tolerance:1}],auditPassed:true,effectiveStartDate:'2026-01-01',effectiveEndDate:'2026-10-23'};
  const call=(args,response)=>({tool:'eastmoney_bond_ledger',arguments:args,fetchedAt:'2026-10-27T10:00:00+08:00',response});
  return {asOf:'2026-10-27',inventory:call({},{databaseDates:performance.map(p=>p.date),availableStartDate:'2026-10-19',availableEndDate:'2026-10-23'}),report:call({query:{start:'2026-01-01',end:'2026-10-23'}},report)};
}
export const composition={focus:[{title:'规模与杠杆',text:'全池市值为1.20亿元，综合杠杆率为120.00%，继续跟踪本金和持仓规模变化。',evidencePaths:['metrics.marketValue','metrics.leverage']},{title:'利率风险',text:'全池 DV01 为1.00万元/BP，后续同步跟踪久期与利率变化。',evidencePaths:['metrics.dv01','metrics.modifiedDuration']},{title:'流动性',text:'交易户资产集中于一年以内，继续跟踪到期安排与可供户配置变化。',evidencePaths:['metrics.oneYearShare','metrics.availableMarketValue']}]};

if(process.argv[1]&&process.argv[1]!=='-'&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const raw=fixture();
  const selected=selectRange(raw);assert.equal(selected.end,'2026-10-23');assert.equal(selected.start,'2026-01-01');
  const future=structuredClone(raw);future.inventory.response.databaseDates.push('2026-10-28');assert.equal(selectRange(future).end,'2026-10-23');
  const emptyYear=structuredClone(raw);emptyYear.asOf='2027-01-03';assert.equal(selectRange(emptyYear).start,'2027-01-01');assert.equal(selectRange(emptyYear).end,'2027-01-03');
  const invalid=structuredClone(raw);invalid.requestedRange={start:'2026-02-30',end:'2026-10-23'};assert.throws(()=>selectRange(invalid),/无效日期/);
  const mismatched=structuredClone(raw);mismatched.report.arguments.query.end='2026-10-22';assert.throws(()=>prepare(mismatched),/不一致/);
  assert.throws(()=>unwrap({isError:true,content:[]}),/取数失败/);assert.throws(()=>unwrap({status:503,detail:'失败'}),/取数失败/);
  assert.deepEqual(unwrap({structuredContent:{data:{databaseDates:[]}}}),{databaseDates:[]});
  assert.deepEqual(unwrap({content:[{type:'text',text:'{"hasData":false}'}]}),{hasData:false});
  const built=prepare(raw);assert.equal(built.review.status,'ready');assert.equal(built.evidence.metrics.weeklyRevenue,500000);
  assert.equal(built.evidence.metrics.fullPoolYtdAnnualizedReturn,0.03);assert.notEqual(built.evidence.metrics.fullPoolYtdAnnualizedReturn,raw.report.response.currentPerformance.ytdAnnualizedReturn);
  assert.equal(built.evidence.metrics.oneYearShare,1);assert.equal(built.evidence.metrics.leverage,1.2);
  const result=render({raw},composition);assert.match(result.html,/3\.000%/);assert.match(result.html,/120\.00%/);assert.match(result.html,/<svg/);
  assert.doesNotMatch(result.html,/<script|<link|@import|<image|<foreignObject|https?:\/\/[^" ]+\.js/i);
  const zero=structuredClone(raw);zero.report.response.availability.pledgedMarketValue=0;zero.report.response.availability.availableMarketValue=1.2e8;
  zero.report.response.operatingTrend.at(-1).cumulativeTaxExemptProfit=0;assert.match(render({raw:zero},composition).html,/免税增厚 0\.0 万元/);
  const missing=structuredClone(raw);missing.report.response.availability.pledgedMarketValue=null;missing.report.response.availability.availableMarketValue=null;
  missing.report.response.operatingTrend.at(-1).fullPoolYtdExTaxAnnualizedReturn=null;missing.report.response.operatingTrend.at(-1).cumulativeTaxExemptProfit=null;
  assert.match(render({raw:missing},composition).html,/已质押持仓市值 —/);assert.match(render({raw:missing},composition).html,/免税增厚 —/);
  const failed=structuredClone(raw);failed.report.response.auditChecks[0].pass=false;failed.report.response.auditPassed=false;assert.equal(prepare(failed).review.status,'audit_failed');assert.throws(()=>render({raw:failed},composition),/不生成 HTML/);
  const noAudit=structuredClone(raw);noAudit.report.response.auditChecks=[];assert.equal(prepare(noAudit).review.status,'audit_failed');
  const damagedAudit=structuredClone(raw);damagedAudit.report.response.auditChecks[0]=null;assert.equal(prepare(damagedAudit).review.status,'audit_failed');
  const nullAudit=structuredClone(raw);nullAudit.report.response.auditChecks[1].actual=null;nullAudit.report.response.auditChecks[1].difference=null;nullAudit.report.response.auditChecks[1].pass=false;nullAudit.report.response.auditPassed=false;assert.equal(prepare(nullAudit).review.status,'audit_failed');
  const fakeAudit=structuredClone(raw);fakeAudit.report.response.auditChecks[0].difference=100;assert.equal(prepare(fakeAudit).review.status,'audit_failed');
  const empty=structuredClone(raw);empty.report.response.hasData=false;empty.report.response.currentPerformance=null;empty.report.response.auditPassed=false;empty.report.response.auditChecks=[];assert.equal(prepare(empty).review.status,'empty');
  const later=structuredClone(raw);later.report.response.operatingTrend.push({...later.report.response.operatingTrend.at(-1),date:'2026-10-26'});assert.throws(()=>prepare(later),/未来数据/);
  const hostile=structuredClone(raw);hostile.report.response.topTradingPositions[0].name='<script>alert("x")</script>';assert.doesNotMatch(render({raw:hostile},composition).html,/<script/);
  assert.throws(()=>render({raw},{focus:composition.focus.map(item=>({...item,evidencePaths:['metrics.unknown']}))}),/引用/);
  const partial=structuredClone(raw);partial.requestedRange={start:'2026-10-21',end:'2026-10-23'};partial.report.arguments.query.start='2026-10-21';assert.equal(prepare(partial).evidence.metrics.weeklyRevenue,300000);assert.match(render({raw:partial},composition).html,/本周区间内营收/);
  const directory=await mkdtemp(join(tmpdir(),'secondary-pool-isolated-'));
  try {
    const installed=join(directory,'skill','scripts');await cp(dirname(fileURLToPath(import.meta.url)),installed,{recursive:true});
    const input=join(directory,'raw.json'),draft=join(directory,'composition.json');await writeFile(input,JSON.stringify(raw));await writeFile(draft,JSON.stringify(composition));
    const cli=join(installed,'report.mjs'),prepared=join(directory,'prepared'),output=join(directory,'result');
    execFileSync(process.execPath,[cli,'prepare',input,prepared],{cwd:directory,env:{PATH:process.env.PATH},stdio:'pipe'});
    execFileSync(process.execPath,[cli,'render',join(prepared,'prepared.json'),draft,output],{cwd:directory,env:{PATH:process.env.PATH},stdio:'pipe'});
    assert.match(await readFile(join(output,'secondary-pool-weekly.html'),'utf8'),/二级债券池运营周报/);
    // Reusing prepare directory for failure removes prior ready files.
    await writeFile(input,JSON.stringify(failed));await main(['prepare',input,prepared]);
    await assert.rejects(readFile(join(prepared,'prepared.json')),/ENOENT/);
    await writeFile(join(prepared,'prepared.json'),JSON.stringify({raw:failed}));
    assert.throws(()=>execFileSync(process.execPath,[cli,'render',join(prepared,'prepared.json'),draft,output],{stdio:'pipe'}));
    await assert.rejects(readFile(join(output,'secondary-pool-weekly.html')),/ENOENT/);
    console.log('PASS: dates, MCP errors, full-pool fields, zero/null, audits, temporal isolation, escaped HTML, offline SVG and isolated CLI');
  } finally {await rm(directory,{recursive:true,force:true});}
}
