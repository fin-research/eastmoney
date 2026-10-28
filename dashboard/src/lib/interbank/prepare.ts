import * as XLSX from 'xlsx';
import { unzipSync, zipSync } from 'fflate';
import { sourceRows, pdfName, type PreparedBatch, type ArchiveFile } from './model.ts';
const MAX_BYTES = 100 * 1024 * 1024;
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(x => x.toString(16).padStart(2,'0')).join('');
}
export function safePath(name: string) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p.includes(':'))) throw new Error('压缩包路径无效');
  return name;
}
export function readExcel(bytes: Uint8Array) {
  const book = XLSX.read(bytes.slice(), { type:'array', cellText:true, cellDates:true, sheetStubs:true, nodim:true });
  const sheet = book.Sheets['信用拆借成交'];
  if (!sheet) throw new Error('缺少信用拆借成交工作表');
  // Derive range from actual cells rather than the producer's often truncated dimension.
  const cells = Object.keys(sheet).filter(key => !key.startsWith('!')).map(key => XLSX.utils.decode_cell(key));
  if (!cells.length) throw new Error('Excel 为空');
  const range = {s:{r:0,c:0},e:{r:0,c:0}};
  for (const cell of cells) {range.e.r=Math.max(range.e.r,cell.r);range.e.c=Math.max(range.e.c,cell.c);}
  if (range.e.r > 10000 || range.e.c > 500) throw new Error('Excel 超出行列限制');
  const rows: string[][] = [];
  for (let r = 0;r <= range.e.r;r++) {
    const row: string[] = [];
    for (let c=0;c<=range.e.c;c++) {
      const cell = sheet[XLSX.utils.encode_cell({r,c})];
      row.push(!cell ? '' : cell.v instanceof Date ? cell.v.toISOString().slice(0,10) : typeof cell.v === 'string' ? cell.v.trim() : typeof cell.v === 'number' && !rows[0]?.[c]?.includes('账号') ? String(cell.v) : XLSX.utils.format_cell(cell));
    }
    rows.push(row);
  }
  return { trades: sourceRows(rows), xlsx: XLSX.write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer };
}
export async function prepareArchive(bytes: Uint8Array, pdfText: (bytes: Uint8Array) => Promise<string>): Promise<PreparedBatch> {
  if (bytes.byteLength > MAX_BYTES) throw new Error('ZIP 超过 100 MB');
  let expanded = 0;
  const namesSeen=new Set<string>();
  const entries = unzipSync(bytes, { filter: entry => {
    safePath(entry.name);
    const key=entry.name.toLowerCase();
    if (namesSeen.has(key)) throw new Error('ZIP 包含重复文件名');
    namesSeen.add(key);
    expanded += entry.originalSize;
    if (expanded > MAX_BYTES) throw new Error('解压文件超过 100 MB');
    return !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/') && !entry.name.endsWith('.DS_Store');
  }});
  const sources = Object.keys(entries);
  const excels = sources.filter(name => /\.xlsx?$/i.test(name));
  if (excels.length !== 1) throw new Error('压缩包须包含一个 Excel');
  const excel = excels[0]!;
  const { trades, xlsx } = readExcel(entries[excel]!);
  if (!trades.length || new Set(trades.map(row=>row['成交日期'])).size !== 1) throw new Error('Excel 包含多个成交日期或没有成交记录');
  const date = trades[0]!['成交日期'];
  const bySerial = new Map(trades.map(row=>[row.serialNo,row]));
  const linked = new Set<string>();
  const files: ArchiveFile[] = [];
  const names = new Set<string>();
  for (const source of sources) {
    let content = entries[source]!, name = source, serialNo: string | undefined;
    if (source === excel) { name = `信用拆借成交查询_${date.replaceAll('-','')}.xlsx`; content = /\.xls$/i.test(excel) ? new Uint8Array(xlsx) : content; }
    else if (/\.pdf$/i.test(source)) {
      const text = await pdfText(content.slice());
      const ids = [...new Set((text.match(/IBO\d{14}/g) ?? source.match(/IBO\d{14}/g)) ?? [])];
      if (ids.length !== 1) throw new Error(`PDF 交易编号无法确定：${source}`);
      serialNo = ids[0]!;
      const trade = bySerial.get(serialNo);
      if (!trade) throw new Error(`PDF 成交编号不在 Excel：${serialNo}`);
      linked.add(serialNo); name = pdfName(source,trade,text);
    }
    if (names.has(name.toLowerCase())) throw new Error('归档文件重名');
    names.add(name.toLowerCase());
    files.push({source,name,bytes:content,serialNo,digest:await digest(content)});
  }
  if (linked.size !== trades.length) throw new Error('Excel 与 PDF 成交编号未完整对应');
  const signature = await digest(new TextEncoder().encode(JSON.stringify({date,trades,files:files.map(({source,name,digest})=>({source,name,digest}))})));
  return { date,trades,files,excel:files.find(file=>file.source===excel)!.name,signature };
}
export function archiveZip(batch: PreparedBatch) {
  return zipSync(Object.fromEntries(batch.files.map(file=>[`${batch.date}/${file.name}`,file.bytes])));
}
