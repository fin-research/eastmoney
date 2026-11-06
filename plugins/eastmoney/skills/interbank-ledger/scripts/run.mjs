#!/usr/bin/env node
// 拆借台账：成交 ZIP → 本地归档 → 资金系统导入、传附件、保存还款草稿并截图归档（不等提交流程）。
//   node run.mjs import <zip> [--root DIR] [--run-dir DIR] [--dry-run]
//   node run.mjs shots  <YYYY-MM-DD> [--root DIR] [--run-dir DIR] [--headed]
// 全程脚本化，只有验证码在 Apple OCR 无把握时由 AI 读图（见 SKILL.md）。不提交流程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Camel, login, shanghaiToday } from './camel.mjs';
import { correctedRecords } from './model.mjs';
import { prepareArchive, saveArchive } from './prepare.mjs';

const log = (...args) => console.error(...args);
const [command, target, ...rest] = process.argv.slice(2);
const flags = new Map();
const VALUE_FLAGS = new Set(['--root', '--run-dir']), BOOLEAN_FLAGS = new Set(['--dry-run', '--headed']);
for (let i = 0; i < rest.length; i++) {
  const flag = rest[i];
  if (VALUE_FLAGS.has(flag) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags.set(flag, rest[++i]);
  else if (BOOLEAN_FLAGS.has(flag)) flags.set(flag, true);
  else { console.error(`未知参数：${flag}`); process.exit(1); }
}

function archiveRoot() {
  const candidates = [flags.get('--root'), process.env.INTERBANK_ARCHIVE_ROOT, path.join(os.homedir(), 'Library/CloudStorage/OneDrive-个人/东方财富/交易/拆借')].filter(v => typeof v === 'string');
  const root = candidates.find(dir => fs.existsSync(dir));
  if (!root) throw new Error('找不到归档根目录：用 --root 或 INTERBANK_ARCHIVE_ROOT 指定（其下按成交日期建子目录）');
  return root;
}
const runDir = () => (typeof flags.get('--run-dir') === 'string' ? flags.get('--run-dir') : path.join(os.homedir(), '.cache/eastmoney-interbank/run'));
const sameIds = (a, b) => JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());

function verifyDraft(draft, row, hid, attachmentIds) {
  if (String(draft.hid) !== String(hid)) throw new Error(`草稿 ID 不符：${row.serialNo}`);
  if (draft.remark !== row.serialNo || (draft.reservationId ?? '') !== (row.financingCode ?? '') || String(draft.repaymentId ?? row.id) !== String(row.id)) throw new Error(`草稿关联不符：${row.serialNo}`);
  if (attachmentIds && !sameIds((draft.attachmentList ?? []).map(item => item.id), attachmentIds)) throw new Error(`草稿附件不符：${row.serialNo}`);
}

async function importBatch(zipPath) {
  const batch = prepareArchive(fs.readFileSync(zipPath));
  log(`成交日 ${batch.date}，${batch.trades.length} 笔，${batch.files.length} 个文件`);
  const summary = { date: batch.date, trades: batch.trades.map(t => t.serialNo), files: batch.files.map(f => f.name) };
  if (flags.has('--dry-run')) return { ...summary, dryRun: true };
  const archive = saveArchive(archiveRoot(), batch);
  log(`已归档 ${archive.dir}（新写 ${archive.written}，已有相同 ${archive.existing}）`);
  Object.assign(summary, { archive: archive.dir });

  const dir = runDir();
  fs.mkdirSync(dir, { recursive: true });
  const journalFile = path.join(dir, `journal-${batch.signature.slice(0, 16)}.json`);
  const journal = { uploads: {}, drafts: {}, ...(fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {}) };
  const persist = () => fs.writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 });

  const camel = new Camel(await login({ runDir: dir }));
  let rows = await camel.rows(batch.date);
  const existing = new Set(rows.map(row => row.serialNo));
  const pending = batch.trades.filter(t => !existing.has(t.serialNo));
  if (pending.length) {
    const excel = batch.files.find(f => f.name === batch.excel);
    const parsed = await camel.parseExcel(excel.bytes, excel.name);
    const records = correctedRecords(parsed, batch.trades, new Set(pending.map(t => t.serialNo)));
    await camel.importRecords(records);
    rows = await camel.rows(batch.date);
    const after = new Set(rows.map(row => row.serialNo));
    for (const t of pending) if (!after.has(t.serialNo)) throw new Error(`导入后未查到台账：${t.serialNo}`);
    log(`已导入 ${pending.length} 笔`);
  } else log('台账已有全部成交，跳过导入');
  summary.imported = pending.map(t => t.serialNo);

  const bySerial = new Map(rows.map(row => [row.serialNo, row]));
  summary.drafts = [];
  for (const trade of batch.trades) {
    const row = bySerial.get(trade.serialNo);
    const recorded = journal.drafts[trade.serialNo];
    if (row.hid) {
      verifyDraft(await camel.draft(row.hid), row, row.hid, recorded?.attachments);
      journal.drafts[trade.serialNo] = { status: 'verified', hid: row.hid, attachments: recorded?.attachments }; persist();
      summary.drafts.push({ serialNo: trade.serialNo, hid: row.hid, status: 'exists' });
      continue;
    }
    // 上次保存请求发出后结果未知：台账上还没有草稿，不盲目重发，避免重复划拨申请。
    if (recorded?.status === 'intent') throw new Error(`草稿保存结果无法确认：${trade.serialNo}，请到资金系统同业拆入页核对：确无该笔草稿时，删除 ${journalFile} 中 drafts.${trade.serialNo} 后再重跑`);
    const ids = [];
    for (const file of batch.files.filter(f => f.serialNo === trade.serialNo)) {
      let id = journal.uploads[file.digest];
      if (!id) { id = (await camel.attach(file.bytes, file.name)).id; if (id == null || id === '') throw new Error(`附件 ID 无效：${file.name}`); journal.uploads[file.digest] = id; persist(); }
      ids.push(id);
    }
    const latest = await camel.freshRow(batch.date, trade.serialNo);
    if (latest.hid) throw new Error(`草稿已被创建：${trade.serialNo}，请重跑`);
    const payload = await camel.draftPayload(latest, ids);
    // 只在真正发出保存请求前记 intent；明确的业务错误说明没有生效，撤销记录，仅结果未知时保留。
    journal.drafts[trade.serialNo] = { status: 'intent', attachments: ids }; persist();
    let hid;
    try { hid = await camel.saveDraft(payload); }
    catch (error) { if (!error.outcomeUnknown) { delete journal.drafts[trade.serialNo]; persist(); } throw error; }
    if (hid == null || hid === '') throw new Error(`草稿 ID 无效：${trade.serialNo}`);
    const draft = await camel.draft(hid);
    verifyDraft(draft, row, hid, ids);
    if (String(draft.reviewStatus) !== '0' || String(draft.status) !== '0') throw new Error(`草稿状态异常：${trade.serialNo}`);
    journal.drafts[trade.serialNo] = { status: 'verified', hid, attachments: ids }; persist();
    summary.drafts.push({ serialNo: trade.serialNo, hid, status: 'saved' });
    log(`草稿已保存 ${trade.serialNo} → ${hid}`);
  }
  return summary;
}

async function shots(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('用法：run.mjs shots <YYYY-MM-DD>');
  const { captureFlows } = await import('./shots.mjs');
  const dir = path.join(archiveRoot(), date);
  const archived = fs.existsSync(dir) ? new Set(fs.readdirSync(dir).flatMap(name => name.match(/IBO\d{14}/g) ?? [])) : null;
  const session = await login({ runDir: runDir() });
  const rows = (await new Camel(session).rows(date)).filter(row => !archived || archived.has(row.serialNo));
  if (!rows.length) throw new Error('当日台账没有可截图的成交');
  const drafted = rows.filter(row => row.hid && String(row.allocateReviewStatus) === '0');
  const result = await captureFlows({ token: session.token, date, trades: drafted.map(row => ({ serialNo: row.serialNo })), outDir: path.join(dir, '流程截图'), headed: flags.has('--headed') });
  const noDraft = rows.filter(row => !drafted.includes(row)).map(row => ({ serialNo: row.serialNo, step: '划拨申请', error: row.hid ? '流程已提交，不再是草稿' : '没有已保存的草稿' }));
  return { date, dir: path.join(dir, '流程截图'), files: result.files.map(f => path.basename(f)), missing: [...noDraft, ...result.missing] };
}

try {
  if (command !== 'import' && command !== 'shots') throw new Error('用法：run.mjs import <zip> | run.mjs shots <YYYY-MM-DD>');
  const result = command === 'import' ? await importBatch(path.resolve(target ?? '')) : await shots(target ?? shanghaiToday());
  console.log(JSON.stringify(result, null, 2));
  if (result.missing?.length) process.exitCode = 2;
} catch (error) {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
}
