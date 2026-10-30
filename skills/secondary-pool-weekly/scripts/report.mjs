import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isoWeek,yearToLatestLedgerRange,renderCharts} from './core.mjs';

const fail=message=>{throw new Error(message);};
const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
const object=(value,label)=>value&&typeof value==='object'&&!Array.isArray(value)?value:fail(`${label} 必须是对象`);
const array=(value,label)=>Array.isArray(value)?value:fail(`${label} 必须是数组`);
export const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const numeric=(value,label,nullable=false)=>isNumber(value)||(nullable&&value===null)?value:fail(`${label} 必须是${nullable?'数值或 null':'有限数值'}`);
export function validDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value) fail(`无效日期：${value}`);
  return value;
}
export function unwrap(response,depth=0) {
  object(response,'MCP 响应');
  if(depth>7) fail('无法识别 MCP 响应');
  if(response.isError||response.error||response.status>=400) fail('MCP 取数失败，不得当作空数据');
  if(response.structuredContent) return unwrap(response.structuredContent,depth+1);
  if(response.data!==undefined) return unwrap(response.data,depth+1);
  if(response.content) {
    const parts=array(response.content,'MCP content').filter(p=>p.type==='text');
    if(parts.length!==1) fail('MCP 响应缺少单一 JSON 文本');
    return unwrap(JSON.parse(parts[0].text),depth+1);
  }
  return response;
}
function callData(call,expectedArguments) {
  object(call,'取数记录');
  if(typeof call.tool!=='string'||!/(^|_)bond_ledger$/.test(call.tool)) fail('必须记录本插件的 bond_ledger MCP 工具调用');
  if(typeof call.fetchedAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(call.fetchedAt)||!Number.isFinite(Date.parse(call.fetchedAt))) fail('fetchedAt 必须为带时区的真实请求时间');
  const args=object(call.arguments,'MCP arguments');
  if(expectedArguments===null) {
    if(Object.keys(args).some(key=>key!=='query')||(args.query&&Object.keys(object(args.query,'query')).length)) fail('台账日期清单必须使用空参数');
  } else {
    if(Object.keys(args).length!==1||!args.query||Object.keys(args.query).length!==2||args.query.start!==expectedArguments.query.start||args.query.end!==expectedArguments.query.end) fail('MCP 查询参数与所选范围不一致');
  }
  return unwrap(call.response);
}
export function selectRange(raw) {
  object(raw,'raw');validDate(raw.asOf);
  const inventory=callData(raw.inventory,null);
  const databaseDates=array(inventory.databaseDates,'databaseDates').map(validDate);
  let range;
  if(raw.requestedRange!==undefined) {
    range=object(raw.requestedRange,'requestedRange');
    validDate(range.start);validDate(range.end);
    if(range.start>range.end||range.end>raw.asOf) fail('起止日期顺序无效或超过截止日');
    range={startDate:range.start,endDate:range.end};
  } else range=yearToLatestLedgerRange(raw.asOf,databaseDates);
  return {asOf:raw.asOf,start:range.startDate,end:range.endDate,arguments:{query:{start:range.startDate,end:range.endDate}},databaseDates};
}
function validatePerformance(row,label) {
  object(row,label);validDate(row.date);
  for(const key of ['principal','timeWeightedPrincipal','marketValue','leverage','modifiedDuration','dailyRevenue','cumulativeProfit']) numeric(row[key],`${label}.${key}`);
  for(const key of ['ytdAnnualizedReturn','ytdExTaxAnnualizedReturn']) numeric(row[key],`${label}.${key}`,true);
}
function validateReport(report,selection) {
  if(typeof report.hasData!=='boolean'||typeof report.auditPassed!=='boolean') fail('报表状态无效');
  array(report.auditChecks,'auditChecks');
  if(!report.hasData) return;
  if(report.currentPerformance===null) return;
  validatePerformance(report.currentPerformance,'currentPerformance');
  const current=report.currentPerformance;
  if(current.date<selection.start||current.date>selection.end) fail('报表基准日超出查询范围');
  if(report.effectiveEndDate!==current.date) fail('报表有效结束日与基准日不一致');
  const dates=selection.databaseDates.filter(date=>date>=selection.start&&date<=selection.end).sort();
  if(dates.at(-1)!==current.date) fail('报表基准日未匹配所选范围最新已入库台账日');
  const trend=array(report.performanceTrend,'performanceTrend');
  let previous='';
  for(const point of trend) {
    validatePerformance(point,'performanceTrend');
    if(point.date<=previous||point.date>current.date) fail('统计序列重复、倒序或包含未来数据');
    previous=point.date;
  }
  previous='';
  for(const point of array(report.operatingTrend,'operatingTrend')) {
    validatePerformance(point,'operatingTrend');
    if(point.date<=previous||point.date>current.date) fail('运营序列重复、倒序或包含未来数据');
    previous=point.date;
    for(const key of ['tradingMarketValue','availableMarketValue','dv01']) numeric(point[key],key);
    for(const key of ['flatStatic','cumulativeTaxExemptProfit','cumulativeExTaxProfit','fullPoolYtdAnnualizedReturn','fullPoolYtdExTaxAnnualizedReturn']) numeric(point[key],key,true);
  }
  for(const field of ['tradingHoldingTypes','tradingMaturityBuckets']) {
    for(const row of array(report[field],field)) {
      if(typeof row[field==='tradingHoldingTypes'?'category':'bucket']!=='string') fail(`${field} 标签无效`);
      numeric(row.marketValue,'marketValue');numeric(row.share,'share');
    }
  }
  const positions=array(report.topTradingPositions,'topTradingPositions');
  if(positions.length>5) fail('Top 5 超过五项');
  for(const row of positions) {
    if(typeof row.name!=='string'||typeof row.category!=='string') fail('Top 5 名称无效');
    numeric(row.marketValue,'marketValue');numeric(row.remainingYears,'remainingYears',true);numeric(row.reportYield,'reportYield',true);
  }
  numeric(report.detailMarketValue,'detailMarketValue');
  object(report.availability,'availability');
  for(const key of ['pledgedMarketValue','availableMarketValue']) numeric(report.availability[key],key,true);
}
function audits(report) {
  const keys=['scale','leverage','profit'];
  const checks=report.auditChecks;
  if(checks.length!==3||checks.some(check=>!check||typeof check!=='object')||new Set(checks.map(check=>check.key)).size!==3||checks.some(check=>!keys.includes(check.key))) return false;
  return checks.every(check=>{
    if(typeof check.label!=='string'||check.pass!==true||![check.actual,check.expected,check.difference,check.tolerance].every(isNumber)) return false;
    const tolerance=check.key==='leverage'?0.000001:1;
    return check.tolerance===tolerance&&Math.abs(check.actual-check.expected)<=tolerance&&Math.abs(check.difference-(check.actual-check.expected))<=1e-8;
  });
}
export function prepare(raw) {
  const selection=selectRange(raw);
  const report=callData(raw.report,selection.arguments);
  validateReport(report,selection);
  const status=!report.hasData?'empty':!report.currentPerformance||!report.auditPassed||!audits(report)?'audit_failed':'ready';
  const review={status,asOf:selection.asOf,requestedRange:{start:selection.start,end:selection.end},effectiveStartDate:report.effectiveStartDate,effectiveEndDate:report.effectiveEndDate,auditChecks:report.auditChecks};
  if(status!=='ready') return {review,selection,report};
  const current=report.currentPerformance;
  const operating=report.operatingTrend.find(point=>point.date===current.date);
  if(!operating) fail('缺少基准日运营数据，不能借用其他日期');
  const inRange=report.performanceTrend.filter(point=>point.date.slice(5)!=='01-01'&&point.date>=selection.start&&point.date<=selection.end);
  if(!inRange.length) fail('所选范围没有有效统计序列');
  const monday=new Date(current.date+'T12:00:00Z');monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  const weekStart=monday.toISOString().slice(0,10);
  const metrics={principal:current.principal,timeWeightedPrincipal:current.timeWeightedPrincipal,marketValue:report.detailMarketValue,
    leverage:current.principal>0?report.detailMarketValue/current.principal:null,
    tradingMarketValue:operating.tradingMarketValue,availableMarketValue:operating.availableMarketValue,
    pledgedMarketValue:report.availability.pledgedMarketValue,availableHoldingMarketValue:report.availability.availableMarketValue,
    fullPoolYtdAnnualizedReturn:operating.fullPoolYtdAnnualizedReturn,fullPoolYtdExTaxAnnualizedReturn:operating.fullPoolYtdExTaxAnnualizedReturn,
    flatStatic:operating.flatStatic,cumulativeProfit:current.cumulativeProfit,taxExemptProfit:operating.cumulativeTaxExemptProfit,
    modifiedDuration:current.modifiedDuration,dv01:operating.dv01,
    oneYearShare:report.tradingMaturityBuckets.slice(0,5).reduce((total,bucket)=>total+bucket.share,0),
    weeklyRevenue:inRange.filter(point=>point.date>=weekStart).reduce((total,point)=>total+point.dailyRevenue,0),
    weeklyRevenueStart:inRange.find(point=>point.date>=weekStart)?.date??null,
    weeklyRevenueComplete:selection.start<=weekStart,
  };
  // These cross-check only relationships already present in the business DTO.
  const scale=report.auditChecks.find(check=>check.key==='scale');
  const leverage=report.auditChecks.find(check=>check.key==='leverage');
  const profit=report.auditChecks.find(check=>check.key==='profit');
  if(Math.abs(scale.actual-report.detailMarketValue)>1||Math.abs(scale.expected-current.marketValue)>1||metrics.leverage===null||Math.abs(leverage.actual-metrics.leverage)>1e-6||Math.abs(leverage.expected-current.leverage)>1e-6||Math.abs(profit.expected-current.dailyRevenue)>1) fail('三维对账与报表字段不一致');
  const evidence={date:current.date,week:isoWeek(current.date),range:{start:inRange[0].date,end:inRange.at(-1).date},metrics,
    tradingHoldingTypes:report.tradingHoldingTypes,tradingMaturityBuckets:report.tradingMaturityBuckets,topTradingPositions:report.topTradingPositions};
  return {review,selection,report,evidence,raw};
}
const fmt=(value,divisor=1,digits=2,suffix='')=>isNumber(value)?`${(value/divisor).toFixed(digits)}${suffix}`:'—';
const yi=value=>fmt(value,1e8,2,' 亿');
const wan=value=>fmt(value,1e4,1,' 万元');
const percent=(value,digits=3)=>fmt(value,0.01,digits,'%');
function lookup(object,path) { return path.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,object); }
function validateComposition(composition,evidence) {
  object(composition,'composition');
  const focus=array(composition.focus,'focus');
  if(focus.length<3||focus.length>4) fail('后续跟踪重点须为 3—4 项');
  for(const item of focus) {
    if(typeof item.title!=='string'||!item.title.trim()||item.title.length>24||typeof item.text!=='string'||!item.text.trim()||item.text.length>240) fail('跟踪重点标题或正文无效');
    const paths=array(item.evidencePaths,'evidencePaths');
    if(!paths.length||paths.some(path=>typeof path!=='string'||lookup(evidence,path)===undefined||lookup(evidence,path)===null)) fail('跟踪重点须引用非空 evidence.json 字段');
  }
  return focus;
}
const css=`*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#172033;font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums}.report{max-width:1080px;margin:28px auto;background:white;padding:30px;border:1px solid #dce3ed}.masthead{background:#0f3d6c;border-radius:6px;display:flex;align-items:center;justify-content:space-between;padding:18px 24px;margin-bottom:20px}h1{font-size:28px;letter-spacing:1px;color:#fff;margin:0}.masthead p{margin:4px 0 0;color:#bfdbfe}.stamp{text-align:right;color:#fff;font-size:14px}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:20px}.metric{padding:12px 10px;border:1px solid #d7e2ee;border-top:3px solid #1e5a94;background:#f5f9fd}.metric:nth-child(even){border-top-color:#14849d}.metric h2{font-size:13px;margin:0 0 8px;font-weight:600;color:#36536e}.value{font-size:23px;line-height:1.35;font-weight:700;color:#103b67;white-space:nowrap}.detail{font-size:12px;line-height:1.65;color:#53677d;margin-top:6px;overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.column{min-width:0}.panel{border:1px solid #dce3ed;margin-bottom:18px;break-inside:avoid}.heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;background:#edf1f5;border-bottom:1px solid #dce3ed;padding:8px 12px}.heading h2{font-size:16px;color:#103b67;margin:0}.meta{font-size:12px;color:#667085}.chart{padding:8px 4px 0}.chart svg{display:block;width:100%;height:auto}.allocation{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:9px 4px 0}.allocation>div{min-width:0}.analysis{padding:7px 12px 12px}.analysis p{margin:7px 0 0}strong{color:#103b67}.holdings{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}.holdings th,.holdings td{padding:9px 7px;border-bottom:1px solid #e4e9f0;text-align:right;overflow-wrap:anywhere}.holdings th:first-child,.holdings td:first-child{text-align:left;width:32%}.holdings td:nth-child(2),.holdings th:nth-child(2){text-align:left;width:20%}.holdings thead{background:#f7f9fb}.focus{margin:10px 16px 14px;padding-left:19px}.focus li{margin:9px 0}.footer{color:#667085;border-top:1px solid #dce3ed;padding-top:13px;text-align:center;font-size:12px}.source{margin-top:8px;font-size:12px;color:#667085}.source a{color:#365a7c}.source dl{display:grid;grid-template-columns:90px 1fr;text-align:left;margin:6px 0}.source dd{margin:0;overflow-wrap:anywhere}@media(max-width:760px){.report{margin:0;padding:18px;border:0}.masthead{align-items:flex-start}.masthead h1{font-size:24px}.stamp{display:none}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics .metric:last-child{grid-column:span 2}.columns{display:block}.value{font-size:23px}.heading{flex-wrap:wrap}.allocation{grid-template-columns:1fr 1fr}}@media print{body{background:white}.report{max-width:none;border:0;margin:0;padding:0}.source{display:none}a{color:inherit;text-decoration:none}.panel{break-inside:avoid}.columns{gap:12px}.metrics{gap:7px}h1{font-size:25px}}`;
export function render(prepared,composition) {
  // Rebuild from the stored MCP input so editing prepared summary cannot bypass audits.
  const data=prepare(prepared.raw);
  if(data.review.status!=='ready') fail('无有效数据或三维对账未通过，不生成 HTML');
  const {evidence:e,selection:s,report}=data,m=e.metrics;
  const focus=validateComposition(composition,e);
  const charts=renderCharts(report,s.start,s.end);
  const card=(label,value,detail)=>`<article class="metric"><h2>${escapeHtml(label)}</h2><div class="value">${escapeHtml(value)}</div><div class="detail">${escapeHtml(detail)}</div></article>`;
  const panel=(title,meta,body)=>`<section class="panel"><div class="heading"><h2>${escapeHtml(title)}</h2><span class="meta">${escapeHtml(meta)}</span></div>${body}</section>`;
  const chart=(svg,label)=>svg?`<div class="chart" role="img" aria-label="${escapeHtml(label)}">${svg}</div>`:'<p class="analysis">暂无有效数据</p>';
  const categories=e.tradingHoldingTypes.slice(0,3).map(item=>`${item.category} ${percent(item.share,1)}`).join('、')||'—';
  const scale=panel('规模演变与杠杆走势',`${e.range.start}—${e.range.end}`,chart(charts.scale,'业务本金、全池市值、时间加权本金与杠杆走势')+`<div class="analysis"><p>• <strong>规模概览：</strong>最新业务本金 ${yi(m.principal)}，全池持仓市值 ${yi(m.marketValue)}，综合杠杆率 ${percent(m.leverage,2)}，已质押持仓市值 ${yi(m.pledgedMarketValue)}，可用持仓市值 ${yi(m.availableHoldingMarketValue)}。</p><p>• <strong>双户结构：</strong>交易户占全池市值 ${percent(m.marketValue>0?m.tradingMarketValue/m.marketValue:null,1)}、可供户占 ${percent(m.marketValue>0?m.availableMarketValue/m.marketValue:null,1)}。</p></div>`);
  const profit=panel('收益率与累计创收归因',`${m.weeklyRevenueComplete?'本周营收':'本周区间内营收'} ${wan(m.weeklyRevenue)}`,chart(charts.profit,'含免税与不含免税年化收益率、平层静态、累计毛利与免税增厚')+`<div class="analysis"><p>• <strong>收益率：</strong>含免税年化收益率 ${percent(m.fullPoolYtdAnnualizedReturn)}，不含免税 ${percent(m.fullPoolYtdExTaxAnnualizedReturn)}，平层静态 ${fmt(m.flatStatic,1,3,'%')}。</p><p>• <strong>利润拆分：</strong>累计毛利（含免税）${wan(m.cumulativeProfit)}，其中免税增厚 ${wan(m.taxExemptProfit)}。</p></div>`);
  const allocation=panel('资产配置与期限分布',`交易户 ${yi(m.tradingMarketValue)}`,`<div class="allocation">${chart(charts.allocation,'交易户资产类别结构')}${chart(charts.maturity,'交易户期限分布')}</div><div class="analysis"><p>• <strong>资产类别：</strong>${escapeHtml(categories)}。</p><p>• <strong>期限结构：</strong>交易户中 1 年以内资产占比约 ${percent(m.oneYearShare,1)}；最新修正久期 ${fmt(m.modifiedDuration,1,4,' 年')}，合并 DV01 ${fmt(m.dv01,1e4,2,' 万元/BP')}。</p></div>`);
  const holdings=panel('核心重仓券速览','Top 5',`<table class="holdings"><thead><tr><th>券名</th><th>类别</th><th>期限</th><th>市值(亿)</th><th>收益率</th></tr></thead><tbody>${e.topTradingPositions.length?e.topTradingPositions.map(p=>`<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.category)}</td><td>${fmt(p.remainingYears,1,2,'Y')}</td><td>${fmt(p.marketValue,1e8,2)}</td><td>${fmt(p.reportYield,1,3,'%')}</td></tr>`).join(''):'<tr><td colspan="5">暂无有效交易户持仓</td></tr>'}</tbody></table>`);
  const follow=panel('后续跟踪重点','',`<ol class="focus">${focus.map(item=>`<li><strong>${escapeHtml(item.title)}：</strong>${escapeHtml(item.text)}</li>`).join('')}</ol>`);
  const cards=[card('业务本金',yi(m.principal),`时间加权 ${yi(m.timeWeightedPrincipal)}`),card('全池持仓总市值',yi(m.marketValue),`交易户 ${yi(m.tradingMarketValue)} / 可供户 ${yi(m.availableMarketValue)}`),card('全池综合杠杆率',percent(m.leverage,2),`对比平层基准 ${fmt(m.leverage===null?null:m.leverage-1,0.01,2,' 个百分点')}`),card('年化收益率（含免税）',percent(m.fullPoolYtdAnnualizedReturn),`不含免税 ${percent(m.fullPoolYtdExTaxAnnualizedReturn)} / 平层静态 ${fmt(m.flatStatic,1,3,'%')}`),card('累计毛利（含免税）',wan(m.cumulativeProfit),`免税增厚 ${wan(m.taxExemptProfit)}`)].join('');
  const source=`<details class="source"><summary>来源与数据范围</summary><dl><dt>来源</dt><dd><a href="https://eastmoney.hasbai.xyz/secondary-bond-pool">Eastmoney 二级池台账</a> · bond_ledger MCP</dd><dt>查询范围</dt><dd>${s.start}—${s.end}</dd><dt>有效统计</dt><dd>${e.range.start}—${e.range.end}</dd><dt>取数时间</dt><dd>${escapeHtml(data.raw.report.fetchedAt)}</dd></dl></details>`;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>二级债券池运营周报 · ${e.date}</title><style>${css}</style></head><body><main class="report"><header class="masthead"><div><h1>二级债券池运营周报</h1><p>报告基准日：${e.date}（${e.week.year}年第${e.week.week}周）</p></div><div class="stamp">资金管理部<br>二级债券池</div></header><div class="metrics">${cards}</div><div class="columns"><div class="column">${scale}${profit}</div><div class="column">${allocation}${holdings}${follow}</div></div><footer class="footer">资金管理部 · 二级债券池内部报告${source}</footer></main></body></html>`;
  return {html,report:{...e,composition,source:{inventory:data.raw.inventory,report:data.raw.report},sha256:createHash('sha256').update(JSON.stringify(data.raw)).digest('hex')},review:data.review};
}
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const write=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
export async function main(args) {
  const [command,inputPath,secondPath,thirdPath]=args;
  if(command==='select') {console.log(JSON.stringify(selectRange(await read(inputPath)),null,2));return;}
  if(command==='prepare') {
    const output=resolve(secondPath);await mkdir(output,{recursive:true});
    // Do not leave a previous success in a reused output directory after failure.
    for(const name of ['prepared.json','evidence.json','composition-template.json','review.json','reconciliation.json']) await rm(join(output,name),{force:true});
    const raw=await read(inputPath),data=prepare(raw);
    await write(join(output,'review.json'),data.review);
    if(data.review.status!=='ready') {await write(join(output,'reconciliation.json'),{status:data.review.status,auditChecks:data.review.auditChecks});console.log(JSON.stringify(data.review));return;}
    await write(join(output,'prepared.json'),{raw});await write(join(output,'evidence.json'),data.evidence);
    await write(join(output,'composition-template.json'),{focus:[{title:'规模与杠杆',text:'',evidencePaths:['metrics.leverage']},{title:'利率风险',text:'',evidencePaths:['metrics.dv01']},{title:'流动性',text:'',evidencePaths:['metrics.oneYearShare']}]});
    console.log(JSON.stringify(data.review));return;
  }
  if(command==='render') {
    const output=resolve(thirdPath);await mkdir(output,{recursive:true});
    for(const name of ['secondary-pool-weekly.html','report.json','review.json']) await rm(join(output,name),{force:true});
    const result=render(await read(inputPath),await read(secondPath));
    await writeFile(join(output,'secondary-pool-weekly.html'),result.html);await write(join(output,'report.json'),result.report);await write(join(output,'review.json'),result.review);
    console.log(join(output,'secondary-pool-weekly.html'));return;
  }
  fail('用法：node report.mjs select raw.json | prepare raw.json outputDir | render prepared.json composition.json outputDir');
}
if(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
