#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {visualHtml} from './visual.mjs';
import {
  z, buildReportData, reportDataSchema, marketReportSnapshotSchema,
  buildMarketBriefingEvidence, buildTextReport, referencedBondCodes,
  omoOperationsSchema, cfetsRatesSchema, governmentBondsSchema, futuresQuotesSchema,
  industrySnapshotSchema, marginBalancesSchema, primaryIssuesSchema,
  todayTradesSchema, favoriteQuotesSchema, bondInfosSchema, tradingDaySchema,
} from './core.mjs';

const date = z.string().date();
const timestamp = z.string().datetime({ offset: true });
const newsItem = z.object({ sentimentId: z.string().min(1), title: z.string(), time: timestamp,
  tags: z.array(z.string()), important: z.boolean().optional(), content: z.string(), link: z.string().url().optional() });
const provenanceSchema = z.array(z.object({resource: z.string(), tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()), fetched_at: timestamp})).min(1);
const newsBatchesSchema = z.array(z.object({offset: z.number().int(), endTime: timestamp,
  items: z.array(newsItem).max(10)})).min(1).max(4);
const resourceSchemas = {omo: omoOperationsSchema, dr: cfetsRatesSchema, dibo: cfetsRatesSchema,
  governmentBonds: governmentBondsSchema, futures: futuresQuotesSchema, industry: industrySnapshotSchema,
  margin: marginBalancesSchema, primary: primaryIssuesSchema, todayTrades: todayTradesSchema,
  favoriteQuotes: favoriteQuotesSchema, bondInfos: bondInfosSchema};
const toolNames = {omo:'omo', dr:'cfets', dibo:'cfets', governmentBonds:'bond_top_case', futures:'futures_latest',
  industry:'industry', margin:'margin', primary:'primary_issues', todayTrades:'today_trades',
  favoriteQuotes:'favorite_quotes', bondInfos:'bond_infos', calendar:'trading_days', snapshot:'market_report'};
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function shanghaiDate(value) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
function must(condition, message) { if (!condition) throw new Error(message); }
function sourceFor(rows, resource) {
  const rowsForKey = rows.filter(row => row.resource === resource);
  must(rowsForKey.length > 0, `缺少 ${resource} 的 MCP 取数记录`);
  must(rowsForKey.every(row => row.tool === toolNames[resource] || row.tool.endsWith('_' + toolNames[resource])), `${resource} 工具名称不匹配`);
  return rowsForKey;
}
function prepareNews(batches, reportDate, cutoff) {
  const seen = new Set();
  const filtered = [];
  batches.forEach((batch, index) => {
    must(batch.offset === index * 10, '新闻 offset 必须按 0/10/20/30 连续分页');
    must(batch.endTime === cutoff, '新闻分页必须固定同一 cutoff_at/endTime');
    must(index === 0 || batches[index - 1].items.length === 10, '短页之后不应继续分页');
    for (const item of batch.items) {
      must(!seen.has(item.sentimentId), `新闻分页重复: ${item.sentimentId}`);
      seen.add(item.sentimentId);
      must(shanghaiDate(item.time) === reportDate && Date.parse(item.time) <= Date.parse(cutoff), `新闻超出报告日/截止时点: ${item.sentimentId}`);
      if (['A股早盘收盘','DMI外币资金日评','DMI离岸债日报'].some(prefix => item.title.startsWith(prefix))) continue;
      let content = item.content;
      const marker = item.title.startsWith('DM债市要闻速览') ? '地方' : item.title.startsWith('DM利率债午间速览') ? '现券方面' : '';
      if (marker) {
        const paragraphs = content.split(/\r?\n\s*\r?\n/);
        const stop = paragraphs.findIndex(p => p.trimStart().startsWith(marker));
        if (stop >= 0) content = paragraphs.slice(0, stop).join('\n\n');
      }
      if (content.trim()) filtered.push({...item, content});
    }
  });
  must(batches.at(-1).items.length < 10 || batches.length === 4, '新闻仍有下一页，请继续采集（最多四批）');
  must(filtered.length > 0, '筛选后的新闻正文为空');
  return {items: filtered, scanned: seen.size, capped: batches.length === 4 && batches.at(-1).items.length === 10};
}
export function prepare(input, mode, now = new Date()) {
  date.parse(input.report_date);
  timestamp.parse(input.cutoff_at);
  const provenance = provenanceSchema.parse(input.provenance);
  const batches = newsBatchesSchema.parse(input.news_batches);
  must(shanghaiDate(input.cutoff_at) === input.report_date, '新闻截止时间必须属于报告日');
  must(Date.parse(input.cutoff_at) <= now.valueOf(), '截止时间不能晚于当前时间');
  const news = prepareNews(batches, input.report_date, input.cutoff_at);
  let report;
  if (mode === 'live') {
    timestamp.parse(input.started_at); timestamp.parse(input.completed_at);
    must(input.report_date === shanghaiDate(now), '实时采集仅允许上海当日，历史日期请使用 archive');
    must([input.started_at,input.completed_at].every(t => shanghaiDate(t) === input.report_date), '实时采集已跨日');
    must(Date.parse(input.started_at) <= Date.parse(input.completed_at) && Date.parse(input.completed_at) <= now.valueOf(), '采集起止时间错误');
    must(Date.parse(input.cutoff_at) <= Date.parse(input.completed_at), '新闻截止晚于采集完成');
    for (const row of provenance) {
      must(Date.parse(row.fetched_at) >= Date.parse(input.started_at) && Date.parse(row.fetched_at) <= Date.parse(input.completed_at), `取数时间越界: ${row.resource}`);
    }
    const calendar = tradingDaySchema.parse(input.calendar);
    sourceFor(provenance, 'calendar');
    must(calendar.date === input.report_date && calendar.isTradingDay, '交易日历未确认报告日为交易日');
    must(date.safeParse(calendar.previousTradingDate).success && calendar.previousTradingDate < input.report_date, '上一交易日无效');
    const resources = {};
    for (const [key, schema] of Object.entries(resourceSchemas)) {
      must(Object.hasOwn(input.resources ?? {}, key) && input.resources[key] !== null, `必需资源缺失: ${key}`);
      resources[key] = schema.parse(input.resources[key]);
      const sources = sourceFor(provenance, key);
      if (['omo','dr','dibo','governmentBonds','industry','margin','primary'].includes(key)) {
        must(sources.every(s => (s.args.date ?? s.args.endDate) === input.report_date), `资源请求日期错误: ${key}`);
      }
    }
    must(sourceFor(provenance,'dr').every(s=>s.args.source === 'DR'), 'DR 请求 source 错误');
    must(sourceFor(provenance,'dibo').every(s=>s.args.source === 'DIBO'), 'DIBO 请求 source 错误');
    must(sourceFor(provenance,'primary').every(s=>s.args.startDate === calendar.previousTradingDate), '一级发行必须从上一交易日查询');
    must(resources.industry.dataDate === input.report_date, '行业/指数行情日期不符');
    must(resources.margin.every(r => shanghaiDate(r.DIM_DATE) <= input.report_date), '两融含未来日期');
    resources.margin.sort((a,b)=>b.DIM_DATE.localeCompare(a.DIM_DATE));
    const infoCodes = new Set(resources.bondInfos.map(row => row.bondUniCode));
    const missing = referencedBondCodes(resources.todayTrades, resources.favoriteQuotes).filter(code => !infoCodes.has(code));
    must(!missing.length, `bond_infos 尚未补全: ${missing.slice(0,10).join(',')}`);
    report = reportDataSchema.parse(buildReportData({...resources, reportDate: input.report_date,
      previousPrimaryDate: calendar.previousTradingDate, generatedAt: input.completed_at,
      stock: {title:'',time:null,paragraphs:[]}}));
  } else if (mode === 'archive') {
    sourceFor(provenance, 'snapshot');
    const snapshot = marketReportSnapshotSchema.parse(input.snapshot);
    must(snapshot.report_date === input.report_date && snapshot.finalized_at !== null, '必须读取同日已定稿快照');
    must(shanghaiDate(snapshot.generated_at) === input.report_date, '快照行情采集日期错误');
    must(Date.parse(snapshot.generated_at) <= Date.parse(input.cutoff_at), '快照生成时间晚于材料截止时间');
    const {focus_text, cached_at, finalized_at, stock_paragraphs, ...observations} = snapshot;
    report = reportDataSchema.parse({...observations, stock_paragraphs:[]});
  } else throw new Error('模式必须为 live 或 archive');
  must(report.industry_data_date === input.report_date, '行业/指数行情日期不符，不能生成完整报告');
  const audit = {mode, report_date:input.report_date, cutoff_at:input.cutoff_at,
    observation_collected_at:report.generated_at, prepared_at:now.toISOString(),
    raw_sha256:sha(input), report_sha256:sha(report), provenance, news_scanned:news.scanned, news_capped:news.capped};
  return {report, evidence:buildMarketBriefingEvidence(report), news:news.items, audit};
}
const compositionSchema = z.object({report_date:date, stock:z.string().trim().min(1).max(160),
  bond:z.string().trim().min(1).max(160), stock_paragraphs:z.array(z.string().trim().min(1)).min(1).max(2),
  citations:z.array(z.object({news_id:z.string(), claim:z.string().trim().min(1)})).min(1)}).strict();
const localTime = value => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(value));
export function render(prepared, composition) {
  const data = reportDataSchema.parse(prepared.report);
  must(sha(data) === prepared.audit.report_sha256, '规范行情已变化，请重新 prepare 后撰写');
  must(prepared.audit.report_date === data.report_date, 'audit 日期不一致');
  const draft = compositionSchema.parse(composition);
  must(draft.report_date === data.report_date, '点评与行情日期不一致');
  const allowed = new Map(prepared.news.map(item=>[item.sentimentId,item]));
  must(draft.citations.every(c=>allowed.has(c.news_id)), '点评引用了未采集的新闻 ID');
  for (const key of ['stock','bond']) {
    must(/[。！？]$/.test(draft[key]) && !/^[12][、.]/.test(draft[key]), `${key} 必须完整收句且不带序号`);
  }
  const report = {...data, stock_paragraphs:draft.stock_paragraphs};
  const focus = `1、${draft.stock}\n2、${draft.bond}`;
  const isIntraday = new Date(report.generated_at).getTime() < new Date(`${report.report_date}T17:00:00+08:00`).getTime();
  const stamp = `${prepared.audit.mode === 'archive' ? '历史重写' : isIntraday ? '盘中' : '收盘'} · 行情采集 ${localTime(report.generated_at)} · 新闻截至 ${localTime(prepared.audit.cutoff_at)}`;
  const text = buildTextReport(report, focus);
  const html = visualHtml({...report, focus_text:focus});
  return {report:{...report,focus_text:focus}, text, html, review:{stock_chars:draft.stock.length,bond_chars:draft.bond.length,
    target_length_ok:[draft.stock,draft.bond].every(s=>s.length>=100 && s.length<=140), citations:draft.citations, stamp}};
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 3) {
    const [mode,inputPath,out] = args;
    const result = prepare(JSON.parse(await readFile(inputPath,'utf8')),mode);
    await mkdir(out,{recursive:true});
    await writeFile(join(out,'prepared.json'),JSON.stringify(result,null,2)+'\n');
    await writeFile(join(out,'evidence.json'),JSON.stringify(result.evidence,null,2)+'\n');
    await writeFile(join(out,'news.json'),JSON.stringify(result.news,null,2)+'\n');
    console.log(JSON.stringify({prepared:resolve(out,'prepared.json'),news_count:result.news.length,mode}));
  } else if (command === 'render' && args.length === 3) {
    const [preparedPath,compositionPath,out] = args;
    const result = render(JSON.parse(await readFile(preparedPath,'utf8')),JSON.parse(await readFile(compositionPath,'utf8')));
    await mkdir(out,{recursive:true});
    await Promise.all([['market-commentary.html',result.html],
      ['report.json',JSON.stringify(result.report,null,2)+'\n'],['review.json',JSON.stringify(result.review,null,2)+'\n']]
      .map(([file,body])=>writeFile(join(out,file),body)));
    console.log(JSON.stringify({html:resolve(out,'market-commentary.html'),...result.review}));
  } else if (command === 'text' && args.length === 2) {
    const result = render(JSON.parse(await readFile(args[0],'utf8')),JSON.parse(await readFile(args[1],'utf8')));
    console.log(result.text);
  } else throw new Error('用法: node report.mjs prepare <live|archive> <raw.json> <输出目录> | node report.mjs render <prepared.json> <composition.json> <输出目录> | node report.mjs text <prepared.json> <composition.json>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
