#!/usr/bin/env node
// 授信周报：归档合并表 → 导出授信一览表 → 周报转数值并入累计簿 → 导出两页 PDF。
// 用法：node run.mjs <合并表.xlsx> [--root DIR] [--date YYYY-MM-DD] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readZip, writeZip } from './zip.mjs';
import { addValuesSheet, excelDate, extractSheet, findSheet, readCells, splitRef } from './ooxml.mjs';
import { buildPlan } from './layout.mjs';

export const SHEET_OVERVIEW = '授信一览表';
export const SHEET_WEEKLY = '授信周报';
export const MASTER_NAME = '证券公司授信周报.xlsx';
export const DEFAULT_ROOT = path.join(os.homedir(), 'Library/CloudStorage/OneDrive-个人/东方财富/授信/授信周报');
const TABLE_HEADER = '银行性质';

const log = msg => process.stderr.write(`${msg}\n`);
const pad = n => String(n).padStart(2, '0');

export function parseArgs(argv) {
  const opts = { root: process.env.CREDIT_WEEKLY_ROOT || DEFAULT_ROOT, dryRun: false, input: null, date: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error('只接受一个输入文件');
  }
  if (!opts.input) throw new Error('用法：node run.mjs <授信一览表+授信周报+融资询价表.xlsx> [--root DIR] [--date YYYY-MM-DD] [--dry-run]');
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('--date 格式应为 YYYY-MM-DD');
  return opts;
}

/** 报告日：--date 优先，否则取授信周报 E1 单元格的日期。 */
export function reportDate(pkg, weeklyPart, override) {
  if (override) { const [y, m, d] = override.split('-').map(Number); return { y, m, d }; }
  const e1 = readCells(pkg, weeklyPart).cells.get('E1');
  if (!e1 || typeof e1.v !== 'number') throw new Error('授信周报 E1 不是日期，请用 --date 指定');
  const dt = excelDate(e1.v);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function names({ y, m, d }) {
  const dotted = `${y}.${pad(m)}.${pad(d)}`;
  return {
    folder: `${y}${pad(m)}${pad(d)}`,
    sheet: `${y}.${m}.${d}`,
    overview: `证券公司授信一览表-${dotted}.xlsx`,
    pdf: `证券公司授信周报${dotted}.pdf`,
  };
}

/** 两页打印区域：第一页周报正文（B:H），第二页授信额度明细表（B:F，从「银行性质」表头起）。隐藏行不计。 */
export function pageAreas(pkg, weeklyPart) {
  const { cells, rows } = readCells(pkg, weeklyPart);
  let header = Infinity;
  for (const [ref, c] of cells) { const p = splitRef(ref); if (p.col === 'B' && c.v === TABLE_HEADER) header = Math.min(header, p.row); }
  if (!Number.isFinite(header)) throw new Error(`授信周报里找不到「${TABLE_HEADER}」表头，无法划分两页`);
  let end1 = 0, end2 = 0;
  for (const ref of cells.keys()) {
    const p = splitRef(ref);
    if (p.colNo < 2 || p.colNo > 8 || rows.get(p.row)?.hidden) continue;
    if (p.row < header) end1 = Math.max(end1, p.row);
    else if (p.colNo <= 6) end2 = Math.max(end2, p.row);
  }
  if (!end1 || end2 <= header) throw new Error('授信周报内容范围异常，无法划分两页');
  return [`B1:H${end1}`, `B${header}:F${end2}`];
}

function assertWellFormed(name, buffer) {
  const r = spawnSync('xmllint', ['--noout', '-'], { input: buffer, encoding: 'utf8' });
  if (r.error) return; // 没有 xmllint 时跳过
  if (r.status !== 0) throw new Error(`生成的 ${name} 不是合法 XML：${r.stderr.slice(0, 300)}`);
}

function writeAtomic(file, buffer) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** 编译 render.swift（按源码哈希缓存在临时目录）。 */
function rendererBinary() {
  const src = path.join(here, 'render.swift');
  const cache = path.join(os.homedir(), 'Library/Caches/credit-weekly');
  fs.mkdirSync(cache, { recursive: true });
  const bin = path.join(cache, `render-${createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 10)}`);
  if (fs.existsSync(bin)) return bin;
  const tmpBin = `${bin}.tmp-${process.pid}`;
  const r = spawnSync('swiftc', ['-O', src, '-o', tmpBin], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`编译 PDF 渲染器失败（需要 Xcode 命令行工具：xcode-select --install）：${(r.error?.message || r.stderr || '').slice(0, 300)}`);
  fs.renameSync(tmpBin, bin);
  return bin;
}

const pdfPages = file => (fs.readFileSync(file, 'latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

/** 按内容划分的打印区域各出一页：A4 纵向、0 边距、水平垂直居中、各自缩放到一页。纯 macOS 自带组件，不依赖 Office。 */
export function renderPdf({ pages }, outFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-weekly-'));
  try {
    const plan = path.join(tmp, 'plan.json'), pdf = path.join(tmp, 'weekly.pdf');
    fs.writeFileSync(plan, JSON.stringify({ pages }));
    const r = spawnSync(rendererBinary(), [plan, pdf], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !fs.existsSync(pdf)) throw new Error(`PDF 渲染失败：${(r.stderr || '').slice(0, 300)}`);
    if (pdfPages(pdf) !== pages.length) throw new Error(`PDF 页数应为 ${pages.length}，实际 ${pdfPages(pdf)}`);
    writeAtomic(outFile, fs.readFileSync(pdf));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function run(opts) {
  const input = path.resolve(opts.input);
  if (!fs.existsSync(input)) throw new Error(`找不到输入文件：${input}`);
  const pkg = readZip(fs.readFileSync(input));
  findSheet(pkg, SHEET_OVERVIEW);
  const weekly = extractSheet(pkg, SHEET_WEEKLY, { formulas: 'values' });
  const when = reportDate(pkg, weekly.sheet.part, opts.date), n = names(when);
  const areas = pageAreas(weekly.pkg, weekly.sheet.part);
  const root = path.resolve(opts.root), dayDir = path.join(root, n.folder), master = path.join(root, MASTER_NAME);
  const layout = buildPlan(weekly.pkg, SHEET_WEEKLY, areas); // 先出版面：样式不认识时在写任何文件前就报错
  for (const w of layout.warnings) log(`提示：${w}`);
  const plan = { date: `${when.y}-${pad(when.m)}-${pad(when.d)}`, dayDir, archived: path.join(dayDir, path.basename(input)), overview: path.join(dayDir, n.overview), master, masterSheet: n.sheet, pdf: path.join(dayDir, n.pdf), areas };
  if (opts.dryRun) return { dryRun: true, ...plan };
  if (!fs.existsSync(master)) throw new Error(`找不到累计周报簿：${master}`);
  if (fs.existsSync(path.join(root, `~$${MASTER_NAME}`))) throw new Error('累计周报簿正在 Excel 中打开，请先关闭再运行');

  fs.mkdirSync(dayDir, { recursive: true });
  if (fs.existsSync(plan.archived) ? fs.realpathSync(plan.archived) !== fs.realpathSync(input) : true) fs.copyFileSync(input, plan.archived);
  log(`已归档 ${plan.archived}`);

  const overview = extractSheet(pkg, SHEET_OVERVIEW, { formulas: 'keep' });
  assertWellFormed('授信一览表 sheet', overview.pkg.get(findSheet(overview.pkg, SHEET_OVERVIEW).part));
  writeAtomic(plan.overview, writeZip(overview.pkg));
  log(`已导出授信一览表（跨表公式转数值 ${overview.droppedFormulas} 个）`);

  const target = readZip(fs.readFileSync(master));
  const { replaced, columnScale } = addValuesSheet(target, weekly.pkg, SHEET_WEEKLY, n.sheet);
  if (columnScale !== 1) log(`累计簿默认字号与周报不同，列宽按 ${columnScale.toFixed(4)} 换算`);
  for (const part of ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']) assertWellFormed(part, target.get(part));
  assertWellFormed('新工作表', target.get(findSheet(target, n.sheet).part));
  fs.copyFileSync(master, path.join(root, `.${MASTER_NAME}.bak`)); // 滚动备份：上一次运行前的累计簿
  writeAtomic(master, writeZip(target));
  log(`${replaced ? '已替换' : '已新增'}累计簿工作表 ${n.sheet}（公式 ${weekly.droppedFormulas} 个转数值）`);

  renderPdf(layout, plan.pdf);
  log(`已导出 PDF ${plan.pdf}`);
  return { ...plan, droppedWeeklyFormulas: weekly.droppedFormulas, droppedOverviewFormulas: overview.droppedFormulas, masterSheetReplaced: replaced, pdfPages: 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(run(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`错误：${e.message}\n`);
    process.exit(1);
  }
}
