import type { Workbook, Worksheet } from 'exceljs';
import { sumAmounts } from './amounts.ts';
import { defaultCreditSort, groupCreditInstitutions } from './sorting.ts';
import type { CreditInstitutionView, CreditItemType, CreditReportResponse } from './types.ts';
import { creditEffectiveStatus, isCreditEffective } from './validity.ts';

// Fixed positions preserve the supplied September 2026 ledger template.
// Retired products and legacy notes remain empty and hidden, never reconstructed.
const widths = [4, 11.59765625, 13.796875, 10, 10.19921875, 9.59765625,
  10.796875, 10.796875, 10.796875, 12.19921875, 11.796875, 11.59765625,
  10.19921875, 9.796875, 10.3984375, 9.19921875, 9.3984375, 8.59765625,
  9.796875, 9, 9.19921875, 10.3984375, 9, 8.796875,
  15.796875, 15.796875, 15.796875, 15.796875, 10.3984375, 13.19921875,
  14.3984375, 81.796875, 28.3984375, 54, 47.796875, 47.796875];
const hiddenColumns = new Set([19, 20, 21, 35, 36]);
const headerMerges = ['B1:AE1', 'B2:B3', 'C2:C3', 'D2:D3', 'E2:F2', 'G2:I2',
  'J2:L2', 'M2:O2', 'P2:R2', 'S2:U2', 'V2:X2', 'Y2:Z2', 'AA2:AA3',
  'AB2:AB3', 'AC2:AC3', 'AD2:AD3', 'AE2:AE3', 'AF2:AF3', 'AG2:AG3', 'AH2:AH3', 'AJ2:AJ3'];
const productColumns: Array<[CreditItemType, number]> = [
  ['bond_investment', 10], ['yield_certificate', 13], ['legal_overdraft', 16], ['interbank_lending', 22],
];
const completeSum = (values: Array<number | null>) => values.some(value => value == null) ? null : sumAmounts(values);
const excelDate = (value: string | null) => value ? new Date(`${value}T00:00:00Z`) : null;

function institutionValues(institution: CreditInstitutionView): Array<string | number | Date | null> {
  const status = creditEffectiveStatus(institution);
  const values: Array<string | number | Date | null> = Array(36).fill(null);
  const set = (column: number, value: string | number | Date | null) => { values[column - 1] = value; };
  set(3, institution.institutionName);
  set(4, institution.confidentialityStatus ? '是' : '否');
  set(5, status === 'approved' ? 1 : 0);
  set(6, status === 'applying' ? 1 : 0);
  set(7, institution.totalLimit); set(8, institution.totalUsed); set(9, institution.availableAmount);
  for (const [type, column] of productColumns) {
    const item = institution.items.find(item => item.type === type);
    set(column, item?.limitAmount ?? null); set(column + 1, item?.usedAmount ?? null); set(column + 2, item?.remainingAmount ?? null);
  }
  const other = institution.items.find(item => item.type === 'other');
  set(25, other?.usedAmount ?? null); set(26, other?.details ?? null);
  set(27, excelDate(institution.effectiveDate)); set(28, excelDate(institution.expiryDate));
  set(29, institution.bankOffice); set(30, institution.applyingDepartment); set(31, institution.handler);
  set(32, institution.detail); set(33, institution.bondPreference); set(34, institution.notes);
  return values;
}

function styleRow(sheet: Worksheet, rowNumber: number, bold = false) {
  const row = sheet.getRow(rowNumber);
  for (let column = 2; column <= 36; column++) {
    const cell = row.getCell(column);
    cell.font = { name: 'SimSun', size: (rowNumber === 2 && (column === 3 || column === 31)) || (rowNumber > 3 && !bold && column === 31) ? 14 : 12, bold, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: rowNumber > 3 && column >= 32 && column <= 34 ? 'left' : 'center', vertical: 'middle', wrapText: true };
    const side = { style: 'thin' as const, color: { argb: 'FF000000' } };
    cell.border = { top: side, bottom: side, left: side, right: side };
    if (rowNumber > 3) {
      cell.numFmt = column === 27 || column === 28 ? 'yyyy/m/d' : column >= 7 && column <= 25 ? '0.00' : column === 5 || column === 6 ? '0' : 'General';
    }
  }
}

/** Estimate wrapped lines using full-width characters, without copying institution-specific template heights. */
function rowHeight(values: Array<string | number | Date | null>): number {
  const height = values.reduce<number>((maximum, value, index) => {
    if (typeof value !== 'string' || hiddenColumns.has(index + 1)) return maximum;
    const capacity = Math.max(1, (widths[index]! - 1) * 0.8 * (index === 30 ? 12 / 14 : 1));
    const wrapped = value.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].reduce((length, char) => length + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / capacity)), 0);
    return Math.max(maximum, wrapped * (index === 30 ? 21 : 18) + 10);
  }, 30);
  return Math.min(409.5, height);
}

export function creditExportFileName(reportDate: string): string {
  return `证券公司授信一览表-${reportDate.replaceAll('-', '.')}.xlsx`;
}

/** The full report is the sole input: search, risk filters and temporary table sorts never enter this export. */
export function populateCreditWorkbook(workbook: Workbook, report: CreditReportResponse): Worksheet {
  const sheet = workbook.addWorksheet('授信一览表', { views: [{ state: 'frozen', xSplit: 12, ySplit: 3, topLeftCell: 'M4', showGridLines: false }] });
  sheet.properties.defaultColWidth = 9;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; sheet.getColumn(index + 1).hidden = hiddenColumns.has(index + 1); });
  sheet.getCell('B1').value = '东方财富证券授信状况一览表';
  const headers: Record<string, string> = {
    B2: '银行性质', C2: '银行名称', D2: '是否签署保密协议/保密承诺函', E2: '状态', G2: '授信额度\n(亿元)',
    J2: '债券投资额度(亿元)', M2: '收益凭证额度(亿元)', P2: '法透额度（亿元）', S2: '两融收益权转让额度(亿元)',
    V2: '同业拆借额度(亿元)', Y2: '其它(亿元)', AA2: '授信生效日', AB2: '授信到期日', AC2: '银行经办机构',
    AD2: '我司申请部门', AE2: '我司经办人', AF2: '备注', AG2: '债券投资偏好', AH2: '已用授信具体情况', AJ2: '已用授信具体情况(旧）',
    E3: '已获批', F3: '申请中', G3: '总额', H3: '已用', I3: '剩余', Y3: '已用', Z3: '明细',
  };
  for (const column of [10, 13, 16, 19, 22]) ['可用', '已用', '剩余'].forEach((label, offset) => { sheet.getRow(3).getCell(column + offset).value = label; });
  for (const [address, value] of Object.entries(headers)) sheet.getCell(address).value = value;
  for (const row of [1, 2, 3]) styleRow(sheet, row, true);
  // The reference title has no enclosing border.
  for (let column = 2; column <= 36; column++) sheet.getRow(1).getCell(column).border = {};
  [42.75, 32.25, 50.25].forEach((height, index) => { sheet.getRow(index + 1).height = height; });
  headerMerges.forEach(range => sheet.mergeCells(range));
  const visible = report.institutions.filter(row => creditEffectiveStatus(row) !== 'revoked');
  let rowNumber = 4;
  for (const group of groupCreditInstitutions(visible, defaultCreditSort)) {
    const start = rowNumber;
    for (const institution of group.institutions) {
      const values = institutionValues(institution);
      sheet.getRow(rowNumber).values = values;
      styleRow(sheet, rowNumber);
      sheet.getRow(rowNumber).height = rowHeight(values);
      rowNumber++;
    }
    sheet.getCell(start, 2).value = group.institutionType;
    if (rowNumber - start > 1) sheet.mergeCells(start, 2, rowNumber - 1, 2);
  }
  const approved = visible.filter(isCreditEffective);
  sheet.getCell(rowNumber, 2).value = '合计';
  sheet.getCell(rowNumber, 5).value = approved.length;
  sheet.getCell(rowNumber, 6).value = visible.length - approved.length;
  sheet.getCell(rowNumber, 7).value = completeSum(approved.map(row => row.totalLimit));
  sheet.getCell(rowNumber, 8).value = completeSum(approved.map(row => row.totalUsed));
  sheet.getCell(rowNumber, 9).value = completeSum(approved.map(row => row.availableAmount));
  for (const [type, column] of productColumns) {
    for (const [offset, key] of ['limitAmount', 'usedAmount', 'remainingAmount'].entries()) {
      const values = approved.map(row => row.items.find(item => item.type === type)?.[key as 'limitAmount' | 'usedAmount' | 'remainingAmount'] ?? null);
      sheet.getCell(rowNumber, column + offset).value = key === 'usedAmount' && type === 'legal_overdraft' ? sumAmounts(values) : completeSum(values);
    }
  }
  sheet.getCell(rowNumber, 25).value = sumAmounts(approved.map(row => row.items.find(item => item.type === 'other')?.usedAmount ?? null));
  styleRow(sheet, rowNumber, true);
  sheet.getRow(rowNumber).height = 30;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', printArea: `B1:AH${rowNumber}` };
  return sheet;
}

export async function createCreditWorkbook(report: CreditReportResponse): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  populateCreditWorkbook(workbook, report);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function downloadCreditWorkbook(report: CreditReportResponse): Promise<void> {
  const buffer = await createCreditWorkbook(report);
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = creditExportFileName(report.summary.reportDate);
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
