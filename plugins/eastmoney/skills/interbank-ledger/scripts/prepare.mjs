// 解压、读 Excel、按 PDF 成交编号关联并重命名，产出待归档的批次。移植自 dashboard/src/lib/interbank/prepare.ts。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip.mjs';
import { readExcel } from './excel.mjs';
import { pdfName } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function swiftBinary(name) {
  const src = path.join(here, `${name}.swift`);
  const bin = path.join(os.tmpdir(), `${name}-${fs.statSync(src).mtimeMs | 0}`);
  if (!fs.existsSync(bin)) execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  return bin;
}

/** PDF 文字层（PDFKit）。无文字层或非 macOS 时返回空串，由文件名兜底。 */
export function pdfText(bytes) {
  if (process.platform !== 'darwin') return '';
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ibo-pdf-')), 'in.pdf');
  try { fs.writeFileSync(tmp, bytes); return execFileSync(swiftBinary('pdf-text'), [tmp], { encoding: 'utf8' }); }
  catch { return ''; }
  finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
}

export function prepareArchive(zipBytes, readPdfText = pdfText) {
  const entries = readZip(zipBytes);
  const excels = entries.filter(e => /\.xlsx?$/i.test(e.name));
  if (excels.length !== 1) throw new Error('压缩包须包含一个 Excel');
  const excel = excels[0];
  const { trades, xlsx } = readExcel(excel.data, excel.name);
  if (!trades.length || new Set(trades.map(row => row['成交日期'])).size !== 1) throw new Error('Excel 包含多个成交日期或没有成交记录');
  const date = trades[0]['成交日期'];
  const bySerial = new Map(trades.map(row => [row.serialNo, row]));
  const linked = new Set(), names = new Set(), files = [];
  for (const entry of entries) {
    let content = entry.data, name = entry.name, serialNo;
    if (entry === excel) { name = `信用拆借成交查询_${date.replaceAll('-', '')}.xlsx`; if (xlsx) content = xlsx; }
    else if (/\.pdf$/i.test(entry.name)) {
      const text = readPdfText(content);
      const ids = [...new Set((text.match(/IBO\d{14}/g) ?? entry.name.match(/IBO\d{14}/g)) ?? [])];
      if (ids.length !== 1) throw new Error(`PDF 交易编号无法确定：${entry.name}`);
      serialNo = ids[0];
      const trade = bySerial.get(serialNo);
      if (!trade) throw new Error(`PDF 成交编号不在 Excel：${serialNo}`);
      linked.add(serialNo); name = pdfName(entry.name, trade, text);
    }
    if (names.has(name.toLowerCase())) throw new Error('归档文件重名');
    names.add(name.toLowerCase());
    files.push({ source: entry.name, name, bytes: content, serialNo, digest: sha256(content) });
  }
  if (linked.size !== trades.length) throw new Error('Excel 与 PDF 成交编号未完整对应');
  const signature = sha256(JSON.stringify({ date, trades, files: files.map(({ source, name, digest }) => ({ source, name, digest })) }));
  return { date, trades, files, excel: files.find(f => f.source === excel.name).name, signature };
}

/** 写入 <root>/<date>/；目标已存在且内容不同则整体拒绝，不覆盖。返回目录。 */
export function saveArchive(root, batch) {
  const dir = path.join(root, batch.date);
  const pending = [];
  for (const file of batch.files) {
    const target = path.join(dir, file.name);
    if (fs.existsSync(target)) { if (sha256(fs.readFileSync(target)) !== file.digest) throw new Error(`目录已有不同文件：${file.name}`); }
    else pending.push([target, file.bytes]);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [target, bytes] of pending) fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  return { dir, written: pending.length, existing: batch.files.length - pending.length };
}
