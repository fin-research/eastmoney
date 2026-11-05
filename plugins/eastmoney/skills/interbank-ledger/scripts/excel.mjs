// 读取「信用拆借成交」工作表，移植自 dashboard/src/lib/interbank/prepare.ts 的 readExcel。
// SheetJS CE（xlsx.mini）随包携带，无需 npm install；.cjs 扩展名保证按 CommonJS 加载。
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceRows } from './model.mjs';

const XLSX = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'xlsx.mini.cjs'));

export function readExcel(bytes, name = '') {
  // SheetJS 读 xlsx 内部 ZIP 时对 data descriptor 条目打印无害告警，读取期间静音。
  const warn = console.error;
  console.error = () => {};
  let book;
  try { book = XLSX.read(bytes, { type: 'buffer', cellText: true, cellDates: true, sheetStubs: true, nodim: true }); }
  finally { console.error = warn; }
  const sheet = book.Sheets['信用拆借成交'];
  if (!sheet) throw new Error('缺少信用拆借成交工作表');
  // 用实际单元格推导范围，不信任生产端常被截断的 dimension。
  const cells = Object.keys(sheet).filter(key => !key.startsWith('!')).map(key => XLSX.utils.decode_cell(key));
  if (!cells.length) throw new Error('Excel 为空');
  const end = { r: 0, c: 0 };
  for (const cell of cells) { end.r = Math.max(end.r, cell.r); end.c = Math.max(end.c, cell.c); }
  if (end.r > 10000 || end.c > 500) throw new Error('Excel 超出行列限制');
  const rows = [];
  for (let r = 0; r <= end.r; r++) {
    const row = [];
    for (let c = 0; c <= end.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(!cell ? '' : cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : typeof cell.v === 'string' ? cell.v.trim() : typeof cell.v === 'number' && !rows[0]?.[c]?.includes('账号') ? String(cell.v) : XLSX.utils.format_cell(cell));
    }
    rows.push(row);
  }
  return { trades: sourceRows(rows), xlsx: /\.xls$/i.test(name) ? Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })) : null };
}
