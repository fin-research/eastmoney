#!/usr/bin/env node
// assemble.mjs — 把 MCP 响应文件目录组装为 raw.json 并直接运行 prepare 校验
//
// 用法:
//   node scripts/assemble.mjs <responses目录> <输出目录>
//
// responses 目录固定文件名（响应内容为 MCP 返回的业务 DTO，不含 transport envelope）:
//   meta.json            必填: {"report_date":"YYYY-MM-DD","mode":"live|archive",
//                              "cutoff_at":"<带时区ISO>","started_at","completed_at",
//                              ["now":"<带时区ISO, 仅离线回放/验证时覆盖 prepare 的当前时间>"],
//                              ["timestamps":{resource:"<ISO>"}],["args":{resource: 覆盖默认调用参数}]}
//   calendar.json        trading_days 响应（live 必填）
//   omo.json dr.json dibo.json governmentBonds.json futures.json industry.json
//   margin.json primary.json todayTrades.json favoriteQuotes.json   （live 必填）
//   bondInfos.json       bond_infos 响应（可选；有成交/报价代码时建议提供）
//   news_batch_0.json .. news_batch_3.json  新闻批次（第 0 批必填）
//   snapshot.json        market_report 定稿响应（archive 必填，live 忽略）
//
// 输出（写入输出目录）:
//   raw.json           完整 raw（含自动 provenance）
//   bond_codes.txt     从成交/报价提取的 bondUniCode 去重列表（供 bond_infos 调用）
//   missing_codes.txt  请求代码中 bondInfos 缺失的部分（存在缺失时写出，不中断）
//   prepared/prepared.json evidence.json news.json   prepare 产物
//
// 时间说明：fetched_at 默认取各响应文件的 mtime，并钳制到 [started_at, completed_at]
// 采集窗口内；需要精确审计时间时在 meta.timestamps 中逐资源提供。
// 本脚本只做确定性组装与校验；MCP 取数、模型判断与写作仍由宿主模型完成。

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_RESOURCES = ['calendar','omo','dr','dibo','governmentBonds','futures','industry','margin','primary','todayTrades','favoriteQuotes'];
const TOOL_NAMES = {calendar:'trading_days', omo:'omo', dr:'cfets', dibo:'cfets', governmentBonds:'bond_top_case',
  futures:'futures_latest', industry:'industry', margin:'margin', primary:'primary_issues',
  todayTrades:'today_trades', favoriteQuotes:'favorite_quotes', bondInfos:'bond_infos', snapshot:'market_report', news:'news_list'};

function fail(message) { console.error(`[assemble] 错误: ${message}`); process.exit(1); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function toIso(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}
function daysAgo(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  d.setDate(d.getDate() - days);
  return toIso(d.getTime()).slice(0, 10);
}
function defaultArgs(resource, meta, calendar) {
  const date = meta.report_date;
  switch (resource) {
    case 'calendar': return { date };
    case 'omo': return { startDate: daysAgo(date, 35), endDate: date };
    case 'dr': return { date, source: 'DR' };
    case 'dibo': return { date, source: 'DIBO' };
    case 'governmentBonds': return { date };
    case 'futures': return {};
    case 'industry': return { date };
    case 'margin': return { date };
    case 'primary': return { date, startDate: calendar && calendar.previousTradingDate };
    case 'todayTrades': return { limit: 300 };
    case 'favoriteQuotes': return { limit: 100 };
    default: return {};
  }
}
function stripOptional(item) {
  // newsItem.link 为可选 url：null/空值一律省略，避免 schema 往返
  const out = { ...item };
  for (const k of ['link', 'important']) {
    if (out[k] === null || out[k] === undefined || out[k] === '') delete out[k];
  }
  return out;
}
function clamp(ms, startMs, endMs) {
  if (!Number.isFinite(ms)) return startMs;
  return Math.min(Math.max(ms, startMs), endMs);
}

async function main() {
  const [responsesDir, outDir] = process.argv.slice(2);
  if (!responsesDir || !outDir) fail('用法: node assemble.mjs <responses目录> <输出目录>');
  if (!statSync(responsesDir).isDirectory()) fail(`responses 目录不存在: ${responsesDir}`);
  mkdirSync(outDir, { recursive: true });
  const preparedDir = join(outDir, 'prepared');
  mkdirSync(preparedDir, { recursive: true });

  const metaPath = join(responsesDir, 'meta.json');
  if (!statSync(metaPath).isFile()) fail('缺少 meta.json');
  const meta = readJson(metaPath);
  if (!meta.report_date || !/^\d{4}-\d{2}-\d{2}$/.test(meta.report_date)) fail('meta.report_date 必须为 YYYY-MM-DD');
  const mode = meta.mode || 'live';
  if (!['live', 'archive'].includes(mode)) fail('meta.mode 必须为 live 或 archive');
  if (!meta.cutoff_at) fail('meta.cutoff_at 必填（新闻截止时间，带时区 ISO）');
  if (!meta.started_at || !meta.completed_at) fail('meta.started_at / completed_at 必填（采集窗口，带时区 ISO）');
  const startMs = Date.parse(meta.started_at);
  const endMs = Date.parse(meta.completed_at);

  const file = name => join(responsesDir, name);
  const has = name => { try { return statSync(file(name)).isFile(); } catch { return false; } };
  const read = name => readJson(file(name));
  const fetchedAt = name => {
    const key = name.replace(/\.json$/, '');
    if (meta.timestamps && meta.timestamps[key]) return meta.timestamps[key];
    return toIso(clamp(statSync(file(name)).mtimeMs, startMs, endMs));
  };

  const raw = {
    report_date: meta.report_date,
    cutoff_at: meta.cutoff_at,
    started_at: meta.started_at,
    completed_at: meta.completed_at,
    provenance: [],
    news_batches: []
  };

  let calendar = null;
  if (mode === 'live') {
    for (const r of LIVE_RESOURCES) {
      const name = `${r}.json`;
      if (!has(name)) fail(`live 模式缺少必填资源 ${name}`);
      const dto = read(name);
      const args = (meta.args && meta.args[r]) || defaultArgs(r, meta, calendar);
      raw.provenance.push({ resource: r, tool: TOOL_NAMES[r], args, fetched_at: fetchedAt(name) });
      if (r === 'calendar') {
        calendar = dto;
        raw.calendar = dto;
        if (!calendar.previousTradingDate) fail('calendar 响应缺少 previousTradingDate');
      } else {
        raw.resources = raw.resources || {};
        raw.resources[r] = dto;
      }
    }
    raw.resources = raw.resources || {};
    // bondInfos 可选：缺省时本地已知空集
    if (has('bondInfos.json')) {
      raw.resources.bondInfos = read('bondInfos.json');
      raw.provenance.push({ resource: 'bondInfos', tool: TOOL_NAMES.bondInfos,
        args: (meta.args && meta.args.bondInfos) || { codes: `${raw.resources.bondInfos.length}个代码` },
        fetched_at: fetchedAt('bondInfos.json') });
    } else {
      raw.resources.bondInfos = [];
      raw.provenance.push({ resource: 'bondInfos', tool: TOOL_NAMES.bondInfos,
        args: { codes: '', skipped_empty_codes: true }, fetched_at: toIso(endMs) });
    }
  } else {
    if (!has('snapshot.json')) fail('archive 模式缺少 snapshot.json');
    raw.snapshot = read('snapshot.json');
    raw.provenance.push({ resource: 'snapshot', tool: TOOL_NAMES.snapshot,
      args: { query: { date: meta.report_date } }, fetched_at: fetchedAt('snapshot.json') });
  }

  // 新闻批次：按文件名序号排序，offset 必须按 0/10/20/30 连续（第 0 批必填）
  const batchFiles = readdirSync(responsesDir).filter(f => /^news_batch_(\d+)\.json$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  if (batchFiles.length === 0 || parseInt(batchFiles[0].match(/\d+/)[0]) !== 0) fail('缺少 news_batch_0.json（新闻第一批必填）');
  batchFiles.forEach((name, index) => {
    const batch = read(name);
    const offset = index * 10;
    const endTime = batch.endTime || meta.cutoff_at;
    const items = (batch.items || []).map(stripOptional);
    raw.news_batches.push({ offset, endTime, items });
    raw.provenance.push({ resource: 'news', tool: TOOL_NAMES.news,
      args: { date: meta.report_date, important: true, detail: true, pageSize: 10, offset, endTime },
      fetched_at: fetchedAt(name) });
  });

  writeFileSync(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');

  // 提取 bondUniCode 列表（live 且有成交/报价时）
  if (mode === 'live') {
    const codes = new Set();
    for (const t of raw.resources.todayTrades || []) if (t.bondUniCode) codes.add(String(t.bondUniCode));
    for (const f of raw.resources.favoriteQuotes || []) if (f.bondUniCode) codes.add(String(f.bondUniCode));
    writeFileSync(join(outDir, 'bond_codes.txt'), [...codes].sort().join(','));
    if (raw.resources.bondInfos.length > 0) {
      const got = new Set(raw.resources.bondInfos.map(b => String(b.bondUniCode)));
      const missing = [...codes].filter(c => !got.has(c));
      if (missing.length > 0) {
        writeFileSync(join(outDir, 'missing_codes.txt'), missing.join(','));
        console.warn(`[assemble] 警告: ${missing.length} 个代码缺少 bondInfos -> ${join(outDir, 'missing_codes.txt')}`);
      }
    }
  }

  // 运行 prepare（复用 report.mjs 的确定性加工与校验）
  const now = meta.now ? new Date(meta.now) : new Date();
  let result;
  try {
    result = prepare(raw, mode, now);
  } catch (e) {
    fail(`prepare 校验未通过: ${e.message}`);
  }
  writeFileSync(join(preparedDir, 'prepared.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(preparedDir, 'evidence.json'), JSON.stringify(result.evidence, null, 2) + '\n');
  writeFileSync(join(preparedDir, 'news.json'), JSON.stringify(result.news, null, 2) + '\n');

  console.log(JSON.stringify({
    mode, raw: resolve(outDir, 'raw.json'),
    prepared: resolve(preparedDir, 'prepared.json'),
    news_count: result.news.length,
    news_scanned: result.audit.news_scanned,
    news_capped: result.audit.news_capped
  }));
}

main().catch(e => { console.error(e); process.exit(1); });