import type { Workbook } from 'exceljs';
import type { DataRow, EntityConfig } from './data-admin';
import { financingToday } from './time.js';

export function populateDebtWorkbook(workbook: Workbook, config: EntityConfig, rows: DataRow[]) {
 const fields = config.fields.filter(field => field.key !== 'created_at' && field.key !== 'updated_at');
 const sheet = workbook.addWorksheet(config.label, { views: [{ state: 'frozen', ySplit: 1 }] });
 sheet.columns = fields.map(field => ({ header: field.label, key: field.key, width: field.type === 'date' ? 15 : 22 }));
 for (const row of rows) sheet.addRow(fields.map(field => {
  const value = row[field.key];
  if (value == null || value === '') return null;
  if (field.type === 'number') return Number(value) * (field.displayFactor ?? 1);
  if (field.type === 'date') return new Date(`${String(value).slice(0,10)}T00:00:00Z`);
  if (field.type === 'boolean') return value ? '是' : '否';
  return String(value);
 }));
 fields.forEach((field,index) => { if(field.type === 'date') sheet.getColumn(index+1).numFmt = 'yyyy-mm-dd'; else if(field.type === 'number') sheet.getColumn(index+1).numFmt = '#,##0.######'; });
 sheet.getRow(1).font = { bold: true };
 sheet.autoFilter = { from: {row:1,column:1}, to: {row:Math.max(1, rows.length+1),column:fields.length} };
 return sheet;
}
export async function downloadDebtWorkbook(config: EntityConfig, rows: DataRow[]) {
 const { default: ExcelJS } = await import('exceljs');
 const workbook = new ExcelJS.Workbook();
 populateDebtWorkbook(workbook, config, rows);
 const buffer = await workbook.xlsx.writeBuffer();
 const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
 const link = document.createElement('a'); link.href = url; link.download = `${config.label}-${financingToday()}.xlsx`;
 document.body.append(link);
 try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000); }
}
