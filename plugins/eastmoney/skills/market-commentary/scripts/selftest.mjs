import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,render,shanghaiDate} from './report.mjs';
import {buildPrimaryModule,buildSecondaryModule,buildInventoryModule,buildTextReport,buildMarketBriefingEvidence} from './core.mjs';

// Synthetic fixtures, never used as market evidence.
const now = new Date('2026-10-27T03:00:00Z');
const dt = '2026-10-27T02:50:00Z';
function raw() {
  const resources = {omo:[],dr:[{bondCode:'DR001',weightedYield:1.3,weightedYieldUpDownValueBp:0}],dibo:[],governmentBonds:[],
    futures:[],industry:{dataDate:'2026-10-27',equities:[],industries:[],turnoverYi:null,turnoverChangeYi:null},
    margin:[],primary:[],todayTrades:[],favoriteQuotes:[],bondInfos:[]};
  const tools = {omo:'omo',dr:'cfets',dibo:'cfets',governmentBonds:'bond_top_case',futures:'futures_latest',industry:'industry',
    margin:'margin',primary:'primary_issues',todayTrades:'today_trades',favoriteQuotes:'favorite_quotes',bondInfos:'bond_infos',calendar:'trading_days'};
  return {report_date:'2026-10-27',cutoff_at:dt,started_at:'2026-10-27T02:45:00Z',completed_at:'2026-10-27T02:55:00Z',
    calendar:{date:'2026-10-27',isTradingDay:true,previousTradingDate:'2026-10-26'},resources,
    provenance:Object.entries(tools).map(([resource,tool])=>({resource,tool,args:{date:'2026-10-27',endDate:'2026-10-27',
      source:resource==='dr'?'DR':'DIBO',startDate:'2026-10-26'},fetched_at:dt})),
    news_batches:[{offset:0,endTime:dt,items:[{sentimentId:'fixture-1',title:'测试新闻',time:dt,tags:[],content:'合成测试事实。'}]}]};
}
function composition() {return {report_date:'2026-10-27',stock:'这是测试用股市点评。',bond:'这是测试用债市点评。',stock_paragraphs:['合成事实。'],citations:[{news_id:'fixture-1',claim:'合成事实'}]};}
test('Shanghai boundary uses date at UTC+8',()=>{
  assert.equal(shanghaiDate('2026-10-26T16:00:00Z'),'2026-10-27');
});
test('live prepare, render, sections, offline and actual timestamp',()=>{
  const prepared = prepare(raw(),'live',now);
  const out=render(prepared,composition());
  for(const section of ['央行','利率','股市','一级发行','二级行情','今日聚焦']) assert.ok(out.text.includes(`【${section}】`));
  assert.ok(out.html.startsWith('<!doctype html>'));
  assert.doesNotMatch(out.text,/截至17:00/);
  assert.ok(out.html.includes('id="market-report-data"'));
  assert.ok(out.html.includes('.report-content'));
  assert.ok(out.html.includes('申万一级行业'));
  assert.doesNotMatch(out.html,/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel=["']stylesheet/i);
  const data=JSON.parse(out.html.match(/<script id="market-report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data,out.report);
  assert.equal(out.review.target_length_ok,false);
});
test('missing resources and wrong nonempty types fail instead of zero/empty',()=>{
  const data=raw(); delete data.resources.industry;
  assert.throws(()=>prepare(data,'live',now),/industry/);
  const wrong=raw(); wrong.resources.dr[0].weightedYield='oops';
  assert.throws(()=>prepare(wrong,'live',now));
});
test('historical live, cross day and future cutoff rejected',()=>{
  assert.throws(()=>prepare(raw(),'live',new Date('2026-10-28T03:00:00Z')),/历史日期/);
  const crossed=raw(); crossed.started_at='2026-10-26T15:59:00Z';
  assert.throws(()=>prepare(crossed,'live',now),/跨日/);
  const future=raw(); future.cutoff_at='2026-10-27T04:00:00Z';
  assert.throws(()=>prepare(future,'live',now),/当前时间/);
});
test('industry date, trading day and previous date guarded',()=>{
  const wrong=raw(); wrong.resources.industry.dataDate='2026-10-26';
  assert.throws(()=>prepare(wrong,'live',now),/行业/);
  const closed=raw();closed.calendar.isTradingDay=false;assert.throws(()=>prepare(closed,'live',now),/交易日/);
  const previous=raw();previous.calendar.previousTradingDate='2026-10-28';assert.throws(()=>prepare(previous,'live',now),/上一交易日/);
});
test('news pagination: duplicate, changing cutoff, short batch, missing next page',()=>{
  const duplicate=raw(); duplicate.news_batches[0].items.push(duplicate.news_batches[0].items[0]);
  assert.throws(()=>prepare(duplicate,'live',now),/重复/);
  const changed=raw();changed.news_batches[0].endTime='2026-10-27T02:49:00Z';assert.throws(()=>prepare(changed,'live',now),/固定/);
  const short=raw();short.news_batches.push({...short.news_batches[0],offset:10});assert.throws(()=>prepare(short,'live',now),/短页/);
  const next=raw();next.news_batches[0].items=Array.from({length:10},(_,i)=>({...next.news_batches[0].items[0],sentimentId:`id-${i}`}));
  assert.throws(()=>prepare(next,'live',now),/下一页/);
});
test('all zero is unchanged; null change never means unchanged',()=>{
  const data=raw();data.resources.dr.push({bondCode:'DR007',weightedYield:1.4,weightedYieldUpDownValueBp:0});
  data.resources.dibo=['DIBO001','DIBO007'].map(bondCode=>({bondCode,weightedYield:1.3,weightedYieldUpDownValueBp:0}));
  data.resources.futures=[{contractCode:'T9999',lastPrice:110,upDownValuePct:null}];
  const prepared=prepare(data,'live',now);const text=buildTextReport(prepared.report,'');
  assert.match(text,/隔夜和7天期利率持平/);
  assert.doesNotMatch(text,/全面上行|全面上涨/);
  assert.match(text,/10年期主力合约涨跌暂缺/);
});
test('unknown primary amount propagates while complex tenors retain known amounts',()=>{
  const rows=[{bidStartDate:'2026-10-27',comShortName:'测试证券',issueTenor:'3+2',planIssueAmount:10},
    {bidStartDate:'2026-10-27',comShortName:'测试证券',issueTenor:'5+2',planIssueAmount:null}];
  const partial=buildPrimaryModule(rows,'2026-10-27','2026-10-26');
  assert.equal(partial.primary_summary.current_amount,null);assert.equal(partial.primary_issues[0].amount,null);
  assert.equal(buildPrimaryModule(rows.slice(0,1),'2026-10-27','2026-10-26').primary_summary.current_amount,10);
});
test('secondary requires all structured classification flags and <=5 year, excludes Eastmoney',()=>{
  const trades=['a','b','c','d'].map(bondUniCode=>({bondUniCode,remainingTenor:'3Y',cbYte:1.6,tradeYield:1.5}));
  trades[3].remainingTenor='6Y';
  const infos=trades.map(({bondUniCode})=>({bondUniCode,bondShortName:'测试债'+bondUniCode,comShortName:'测试证券',bondType:37,bondOfferingType:1,sciTechInnoBondStatus:0}));
  infos[1].sciTechInnoBondStatus=null;infos[2].comShortName='东方财富';
  assert.deepEqual(buildSecondaryModule(trades,infos).secondary_bonds.map(r=>r.bond_id),['a']);
});
test('inventory rejects price 100, falls back and recalculates spread; nonpositive bid absent',()=>{
  const quotes=[{bondUniCode:'em',remainingTenor:'1Y',cbYield:1.5,tradeEntryPrice:100,tradeYieldSubCb:9000,bidYield:0,bidEntryPrice:0,ofrYield:-1}];
  const rows=buildInventoryModule(quotes,[{bondUniCode:'em',remainingTenor:'1Y',tradeYield:1.52}],[]).inventory_bonds;
  assert.equal(rows[0].trade_yield,1.52);assert.equal(rows[0].trade_spread_bp,2);assert.equal(rows[0].bid_yield,null);assert.equal(rows[0].ofr_yield,null);
});
test('two-period margin metrics retain nulls and latest date',()=>{
  const input=raw();input.resources.margin=[{DIM_DATE:'2026-10-26',TOTAL_RZRQYE:2e8,TOTAL_RZYE:null,TOTAL_RQYE:1e8},
    {DIM_DATE:'2026-10-23',TOTAL_RZRQYE:1e8,TOTAL_RZYE:1e8,TOTAL_RQYE:null}];
  const result=prepare(input,'live',now).report.margin;
  assert.equal(result.data_date,'2026-10-26');assert.equal(result.total_change,1);assert.equal(result.financing_change,null);assert.equal(result.securities_lending_change,null);
});
test('OMO null amount does not produce partial net total',()=>{
  const data=raw();data.resources.omo=[{operationDate:'2026-10-27',operationName:'逆回购',duration:'7D',interestRate:1.4,operationAmount:100},
    {operationDate:'2026-10-27',operationName:'逆回购到期',duration:'7D',interestRate:null,operationAmount:null}];
  assert.match(buildTextReport(prepare(data,'live',now).report,''),/净投放金额暂缺/);
});
test('MLF-only injection does not imply reverse repo conducted',()=>{
  const data=raw();data.resources.omo=[{operationDate:'2026-10-27',operationName:'MLF',duration:'1Y',interestRate:null,operationAmount:100}];
  assert.match(buildTextReport(prepare(data,'live',now).report,''),/今日未开展逆回购操作/);
});
test('archive strips old writing, rejects mismatched/future snapshot',()=>{
  const live=prepare(raw(),'live',now);
  const archive={report_date:live.report.report_date,cutoff_at:'2026-10-27T02:56:00Z',snapshot:{...live.report,focus_text:'OLD FOCUS',stock_paragraphs:['OLD STOCK'],cached_at:dt,finalized_at:dt},
    news_batches:raw().news_batches.map(b=>({...b,endTime:'2026-10-27T02:56:00Z'})),provenance:[{resource:'snapshot',tool:'market_report',args:{query:{date:'2026-10-27'}},fetched_at:dt}]};
  const result=prepare(archive,'archive',now);
  assert.equal(result.report.focus_text,undefined);assert.deepEqual(result.report.stock_paragraphs,[]);
  archive.snapshot.industry_data_date='2026-10-26';
  assert.throws(()=>render(prepare(archive,'archive',now),composition()),/行情日期不符/);
  archive.snapshot.industry_data_date='2026-10-27';
  archive.snapshot.report_date='2026-10-26';assert.throws(()=>prepare(archive,'archive',now),/同日/);
});
test('evidence excludes old text and stale industry block',()=>{
  const report=prepare(raw(),'live',now).report;
  report.industry_data_date='2026-10-26';report.equities=[{name:'test',close:1,change_pct:1}];report.turnover_yi=10;
  const evidence=buildMarketBriefingEvidence({...report,focus_text:'do not use',stock_paragraphs:['do not use']});
  assert.deepEqual(evidence.equities,[]);assert.equal(evidence.turnover_yi,null);assert.equal(evidence.focus_text,undefined);assert.equal(evidence.stock_paragraphs,undefined);
});
test('render validates date, references, length, punctuation and escapes HTML',()=>{
  const prepared=prepare(raw(),'live',now);const c=composition();c.stock='<script>alert(1)</script>。';
  assert.ok(render(prepared,c).html.includes('\\u003cscript>'));
  const invalid=composition();invalid.citations[0].news_id='not-collected';assert.throws(()=>render(prepared,invalid),/未采集/);
  const tooLong=composition();tooLong.stock='字'.repeat(161)+'。';assert.throws(()=>render(prepared,tooLong));
  const cut=composition();cut.bond='没有完整收句';assert.throws(()=>render(prepared,cut),/完整收句/);
  prepared.report.turnover_yi=1;assert.throws(()=>render(prepared,composition()),/行情已变化/);
});
