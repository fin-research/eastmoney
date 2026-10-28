import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { createCreditWorkbook, creditExportFileName } from '../src/lib/credit/export.ts';
import { creditItemTypes } from '../src/lib/credit/types.ts';

const institution = (institutionName, institutionType, extra = {}) => ({
  institutionName, institutionType, reportDate: '2026-09-30', status: 'approved', confidentialityStatus: true,
  totalLimit: 20, totalUsed: 5, availableAmount: 15, effectiveDate: '2026-01-01', expiryDate: '2027-09-30',
  bankOffice: '测试经办机构', applyingDepartment: '资金管理部', handler: '测试经办人',
  detail: '测试备注', bondPreference: '测试偏好', notes: '测试已用情况',
  items: creditItemTypes.map(type => ({ type, limitAmount: 10, usedAmount: 2, remainingAmount: 8, details: '测试其它说明' })),
  ...extra,
});
export const exportSample = {
  summary: { reportDate: '2026-09-30', totalLimit: 40, totalUsed: 10, totalAvailable: 30 },
  institutions: [
    institution('模拟股份行', '股份行', { totalLimit: 99, expiryDate: '2026-09-01' }),
    institution('模拟国有乙', '国有银行', { totalLimit: 10, confidentialityStatus: false }),
    institution('模拟国有甲', '国有行', { totalLimit: 30, notes: '第一行\n' + '较长的模拟授信用量情况；'.repeat(20) }),
    institution('模拟撤销行', '城商行', { expiryDate: '1970-01-01' }),
  ],
};
async function read(report) {
  const bytes = await createCreditWorkbook(report);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
  return { bytes, workbook, sheet: workbook.getWorksheet('授信一览表') };
}

test('export reproduces the template structure with grouped full-report data and literal numeric totals', async () => {
  const { bytes, workbook, sheet } = await read(exportSample);
  assert.equal(creditExportFileName('2026-09-30'), '证券公司授信一览表-2026.09.30.xlsx');
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(sheet.rowCount, 7);
  assert.deepEqual([4, 5, 6].map(row => sheet.getCell(row, 3).value), ['模拟国有甲', '模拟国有乙', '模拟股份行']);
  assert.equal(sheet.getCell('B4').value, '国有行');
  assert.ok(sheet.getCell('B5').isMerged);
  assert.equal(sheet.getCell('B1').value, '东方财富证券授信状况一览表');
  for (const merge of ['B1:AE1', 'B4:B5', 'E2:F2', 'J2:L2']) assert.ok(sheet.model.merges.includes(merge));
  assert.equal(sheet.getCell('D5').value, '否');
  assert.deepEqual([sheet.getCell('E6').value, sheet.getCell('F6').value], [0, 1]);
  assert.deepEqual([sheet.getCell('E7').value, sheet.getCell('F7').value], [2, 1]);
  assert.deepEqual(['G7', 'H7', 'I7'].map(address => sheet.getCell(address).value), [40, 10, 30]);
  assert.equal(sheet.getCell('J7').value, 20); // excludes applying institution
  assert.equal(sheet.getCell('Y4').value, 2);
  assert.equal(sheet.getCell('Z4').value, '测试其它说明');
  assert.equal(sheet.getCell('AA4').value.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(sheet.getCell('AA4').numFmt, 'yyyy/m/d');
  assert.equal(sheet.getCell('G4').numFmt, '0.00');
  assert.equal(sheet.getCell('AF4').font.name, 'SimSun');
  assert.equal(sheet.getCell('C2').font.size, 14);
  assert.equal(sheet.getCell('AE2').font.size, 14);
  assert.equal(sheet.getCell('AE4').font.size, 14);
  assert.equal(sheet.getCell('AF4').font.size, 12);
  assert.equal(sheet.getCell('AH4').alignment.horizontal, 'left');
  assert.equal(sheet.getCell('G4').border.left.style, 'thin');
  assert.ok(sheet.getRow(4).height > sheet.getRow(5).height);
  assert.deepEqual([sheet.views[0].xSplit, sheet.views[0].ySplit, sheet.views[0].showGridLines], [12, 3, false]);
  for (const column of [19, 20, 21, 35, 36]) {
    assert.equal(sheet.getColumn(column).hidden, true);
    for (const row of [4, 5, 6, 7]) assert.equal(sheet.getCell(row, column).value, null);
  }
  for (const column of [7, 8, 9]) assert.equal(sheet.getColumn(column).width, 10.796875);
  for (const column of [25, 26, 27, 28]) assert.equal(sheet.getColumn(column).width, 15.796875);
  const files = XLSX.read(bytes, { type: 'array', bookFiles: true }).files;
  const xml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml'].content);
  assert.doesNotMatch(xml, /<f[ >]|conditionalFormatting/);
  assert.match(xml, /topLeftCell="M4"/);
  assert.match(xml, /defaultColWidth="9"/);
  assert.equal(sheet.getColumn(23).width ?? sheet.properties.defaultColWidth, 9);
});

test('missing financing remains blank, while zero and negative amounts remain numeric', async () => {
  const row = institution('模拟缺失行', '城商行', { totalUsed: null, availableAmount: null });
  row.items[0] = { ...row.items[0], usedAmount: -2, remainingAmount: 12 };
  row.items[1] = { ...row.items[1], usedAmount: null, remainingAmount: null };
  row.items[2] = { ...row.items[2], usedAmount: null, remainingAmount: null };
  row.items[3] = { ...row.items[3], usedAmount: 0, remainingAmount: 10 };
  row.items[4] = { ...row.items[4], usedAmount: null };
  const { sheet } = await read({ ...exportSample, institutions: [row] });
  assert.equal(sheet.getCell('H4').value, null);
  assert.equal(sheet.getCell('H5').value, null);
  assert.equal(sheet.getCell('I5').value, null);
  assert.equal(sheet.getCell('K4').value, -2);
  assert.equal(sheet.getCell('N4').value, null);
  assert.equal(sheet.getCell('N5').value, null);
  assert.equal(sheet.getCell('O5').value, null);
  assert.equal(sheet.getCell('Q5').value, 0); // existing manual sum caliber
  assert.equal(sheet.getCell('W4').value, 0);
  assert.equal(sheet.getCell('W5').value, 0);
  assert.equal(sheet.getCell('Y5').value, 0);
});

test('an empty report has headers and a zero-count total without old template rows', async () => {
  const { sheet } = await read({ ...exportSample, institutions: [] });
  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.getCell('E4').value, 0);
  assert.equal(sheet.getCell('F4').value, 0);
});

test('very long notes retain all text with a valid Excel row height', async () => {
  const notes = '模拟长备注'.repeat(5000);
  const { sheet } = await read({ ...exportSample, institutions: [institution('模拟长文本行', '城商行', { notes })] });
  assert.equal(sheet.getCell('AH4').value, notes);
  assert.equal(sheet.getRow(4).height, 409.5);
});
