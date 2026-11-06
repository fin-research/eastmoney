#!/usr/bin/env node
// 离线自测：node scripts/selftest.mjs。用合成工作簿验证拆表、转数值、样式并入、分页范围、版面和 PDF；不写用户目录。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readZip, writeZip } from './zip.mjs';
import { addValuesSheet, extractSheet, listSheets, readCells } from './ooxml.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlan } from './layout.mjs';
import { formatCode, formatValue } from './numfmt.mjs';
import { names, pageAreas, parseArgs, renderPdf, reportDate } from './run.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const styles = ({ fontSize, extra = '', dxfColor = 'FFFF0000' }) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00_ "/></numFmts><fonts count="2"><font><sz val="${fontSize}"/><name val="等线"/></font><font><b/><sz val="12"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${2 + (extra ? 1 : 0)}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>${extra}</cellXfs><dxfs count="1"><dxf><font><color rgb="${dxfColor}"/></font></dxf></dxfs></styleSheet>`;

const sstXml = list => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${NS}" count="${list.length}" uniqueCount="${list.length}">${list.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`;
const sheetXml = (rows, extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="${REL}"><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="12" style="1" customWidth="1"/></cols><sheetData>${rows}</sheetData>${extra}</worksheet>`;

function workbook({ sheets, fontSize, sst, definedNames = '', extraXf = '', dxfColor }) {
  const parts = new Map();
  const files = sheets.map((s, i) => ({ ...s, file: `xl/worksheets/sheet${i + 1}.xml`, rid: `rId${i + 1}` }));
  parts.set('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${files.map(f => `<Override PartName="/${f.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`));
  parts.set('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`));
  parts.set('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant><vt:variant><vt:i4>${files.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${files.length}" baseType="lpstr">${files.map(f => `<vt:lpstr>${f.name}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`));
  parts.set('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="2"/></bookViews><sheets>${files.map((f, i) => `<sheet name="${f.name}" sheetId="${i + 10}" r:id="${f.rid}"/>`).join('')}</sheets>${definedNames}<calcPr calcId="1"/></workbook>`));
  parts.set('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}">${files.map(f => `<Relationship Id="${f.rid}" Type="${REL}/worksheet" Target="worksheets/${f.file.split('/').pop()}"/>`).join('')}<Relationship Id="rId90" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId91" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId92" Type="${REL}/calcChain" Target="calcChain.xml"/></Relationships>`));
  parts.set('xl/calcChain.xml', Buffer.from(`<calcChain xmlns="${NS}"><c r="C2" i="10"/></calcChain>`));
  parts.set('xl/styles.xml', Buffer.from(styles({ fontSize, extra: extraXf, dxfColor })));
  parts.set('xl/sharedStrings.xml', Buffer.from(sstXml(sst)));
  for (const f of files) parts.set(f.file, Buffer.from(f.xml));
  return parts;
}

// ---- 输入合并表：授信一览表（含同表公式、跨表公式、共享公式）、债券投资余额、授信周报 ----
const overviewRows = '<row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1"><v>5</v></c><c r="C1"><v>7</v></c></row>'
  + '<row r="2"><c r="A2"><v>1</v></c><c r="B2" s="1"><f>A2*2</f><v>2</v></c><c r="C2" t="str"><f>债券投资余额!A1&amp;"x"</f><v>abcx</v></c>'
  + '<c r="D2"><f t="shared" ref="D2:D3" si="0">债券投资余额!B1+1</f><v>10</v></c></row>'
  + '<row r="3"><c r="D3"><f t="shared" si="0"/><v>11</v></c><c r="E3"><f t="array" ref="E3">IFERROR(XLOOKUP(A1,债券投资余额!A:A,债券投资余额!B:B),"")</f><v>9</v></c></row>';
const weeklyRows = '<row r="1"><c r="D1" t="s"><v>2</v></c><c r="E1" s="1"><f>TODAY()</f><v>46325</v></c></row>'
  + '<row r="3"><c r="B3" t="s"><v>3</v></c><c r="D3" s="1"><f>授信一览表!B2</f><v>3606.85</v></c></row>'
  + '<row r="10"><c r="B10" t="s"><v>4</v></c><c r="H10"><v>1</v></c></row>'
  + '<row r="20" hidden="1"><c r="B20" t="s"><v>5</v></c></row>'
  + '<row r="21"><c r="B21" t="s"><v>6</v></c></row>'
  + '<row r="22"><c r="C22" t="s"><v>7</v></c><c r="D22"><v>1</v></c></row>'
  + '<row r="23"><c r="C23" t="s"><v>8</v></c><c r="F23"><v>2</v></c><c r="G23"><v>9</v></c></row>';
const SRC_SST = ['名称', '区域', '授信周报', '总额', '快讯', '隐藏说明', '银行性质', '中山农商行', '建设银行'];
const cf = '<conditionalFormatting sqref="D3"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>';
const input = workbook({
  fontSize: 10, sst: SRC_SST, dxfColor: 'FF0000FF',
  definedNames: '<definedNames><definedName name="F" localSheetId="0">授信一览表!$A$1:$B$3</definedName><definedName name="G" localSheetId="2">授信周报!$A$1</definedName></definedNames>',
  sheets: [
    { name: '授信一览表', xml: sheetXml(overviewRows) },
    { name: '债券投资余额', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>9</v></c></row>') },
    { name: '授信周报', xml: sheetXml(weeklyRows, cf) },
  ],
});

// ---- 累计周报簿：默认字号 11，已有 2 个日期 sheet 和按位置绑定的打印区域 ----
const master = () => workbook({
  fontSize: 11, sst: ['旧表'], extraXf: '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  definedNames: '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">\'2026.10.23\'!$B$1:$F$9</definedName></definedNames>',
  sheets: [
    { name: '2026.10.30', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') },
    { name: '2026.10.23', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>').replace(' tabSelected="1"', '') },
  ],
});

const has = (pkg, part, re) => re.test(pkg.get(part).toString('utf8'));
const wellFormed = pkg => {
  if (spawnSync('xmllint', ['--version']).error) return;
  for (const [name, data] of pkg) if (/\.(xml|rels)$/.test(name)) assert.equal(spawnSync('xmllint', ['--noout', '-'], { input: data }).status, 0, `XML 不合法：${name}`);
};

// 1. zip 往返与参数、命名、日期
assert.deepEqual([...readZip(writeZip(input)).keys()], [...input.keys()]);
assert.throws(() => parseArgs([]), /用法/);
assert.throws(() => parseArgs(['a.xlsx', '--date', '2026/1/1']), /--date/);
assert.deepEqual(names({ y: 2026, m: 9, d: 4 }), { folder: '20260904', sheet: '2026.9.4', overview: '证券公司授信一览表-2026.09.04.xlsx', pdf: '证券公司授信周报2026.09.04.pdf' });

// 2. 授信一览表：同表公式保留，跨表公式（含共享、数组、字符串结果）转数值
const overview = extractSheet(input, '授信一览表', { formulas: 'keep' });
assert.deepEqual(listSheets(overview.pkg).map(s => s.name), ['授信一览表']);
assert.equal(overview.droppedFormulas, 4);
const ovSheet = overview.pkg.get('xl/worksheets/sheet1.xml').toString('utf8');
assert.match(ovSheet, /<f>A2\*2<\/f>/);
assert.doesNotMatch(ovSheet, /债券投资余额|<f t="shared"/);
assert.ok(!overview.pkg.has('xl/calcChain.xml') && !overview.pkg.has('docProps/app.xml'));
assert.doesNotMatch(overview.pkg.get('[Content_Types].xml').toString(), /calcChain|app\.xml|sheet2|sheet3/);
assert.doesNotMatch(overview.pkg.get('xl/workbook.xml').toString(), /activeTab|授信周报!/);
assert.equal(readCells(overview.pkg, 'xl/worksheets/sheet1.xml').cells.get('C2').v, 'abcx');
assert.equal(readCells(overview.pkg, 'xl/worksheets/sheet1.xml').cells.get('D3').v, 11);
wellFormed(overview.pkg);

// 3. 授信周报：全部转数值、日期、分页范围（隐藏行不计）
const weekly = extractSheet(input, '授信周报', { formulas: 'values' });
assert.equal(weekly.droppedFormulas, 2);
assert.doesNotMatch(weekly.pkg.get(weekly.sheet.part).toString(), /<f[\s>/]/);
assert.deepEqual(reportDate(weekly.pkg, weekly.sheet.part), { y: 2026, m: 10, d: 30 });
assert.deepEqual(reportDate(weekly.pkg, weekly.sheet.part, '2026-11-06'), { y: 2026, m: 11, d: 6 });
assert.deepEqual(pageAreas(weekly.pkg, weekly.sheet.part), ['B1:H10', 'B21:F23']);
assert.match(weekly.pkg.get('xl/workbook.xml').toString(), /localSheetId="0"/);
wellFormed(weekly.pkg);

// 4. 并入累计簿：新增到最前，样式、字符串、打印区域序号与列宽正确
const target = master();
const added = addValuesSheet(target, weekly.pkg, '授信周报', '2026.11.6');
assert.equal(added.replaced, false);
assert.deepEqual(listSheets(target).map(s => s.name), ['2026.11.6', '2026.10.30', '2026.10.23']);
assert.deepEqual(listSheets(target).map(s => s.sheetId), [12, 10, 11]);
assert.match(target.get('xl/workbook.xml').toString(), /activeTab="0"/);
assert.match(target.get('xl/workbook.xml').toString(), /<definedName name="_xlnm\.Print_Area" localSheetId="2">/);
assert.match(target.get('docProps/app.xml').toString(), /<vt:i4>3<\/vt:i4>.*size="3".*<vt:lpstr>2026\.11\.6<\/vt:lpstr><vt:lpstr>2026\.10\.30/);
const cells = readCells(target, added.part).cells;
assert.equal(cells.get('B3').v, '总额');
assert.equal(cells.get('B21').v, '银行性质');
assert.equal(cells.get('D3').v, 3606.85);
assert.equal(listSheets(target).filter(s => has(target, s.part, /tabSelected="1"/)).length, 1);
const merged = target.get(added.part).toString();
assert.doesNotMatch(merged, /<f[\s>/]|<extLst|xr:uid/);
assert.match(merged, /<col min="1" max="1" width="10" style="\d+"/); // 12 × (5/6)
const xfs = [...target.get('xl/styles.xml').toString().match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf\b/g)].length;
assert.match(target.get('xl/styles.xml').toString(), new RegExp(`<cellXfs count="${xfs}">`));
assert.match(target.get('xl/styles.xml').toString(), /<numFmt numFmtId="165" formatCode="0\.00_ "\/>|<numFmt numFmtId="164" formatCode="0\.00_ "\/>/);
assert.match(target.get('xl/styles.xml').toString(), /<dxfs count="2">/);
assert.match(merged, /dxfId="1"/);
wellFormed(target);

// 5. 同名 sheet 原位替换，重复运行不增加工作表
const again = addValuesSheet(target, weekly.pkg, '授信周报', '2026.11.6');
assert.equal(again.replaced, true);
assert.equal(listSheets(target).length, 3);
assert.equal(again.part, added.part);
assert.match(target.get('xl/styles.xml').toString(), /<dxfs count="2">/); // dxf 去重，重跑不增长
wellFormed(target);

// 6. 数字格式
assert.equal(formatValue(2536.0855, '0.00_ '), '2536.09 ');
assert.equal(formatValue(0.1666, '0%'), '17%');
assert.equal(formatValue(1234567.891, '#,##0.00_ '), '1,234,567.89 ');
assert.equal(formatValue(46325, 'yyyy/m/d'), '2026/10/30');
assert.equal(formatValue(46325, 'yyyy"."m"."d'), '2026.10.30');
assert.equal(formatValue(-3.456, '0.00_);[Red]\\(0.00\\)'), '(3.46)');
assert.equal(formatValue(12, 'General'), '12');
assert.equal(formatValue('文本', '0.00'), '文本');
assert.equal(formatValue(1.4210854715202e-14, '0.00_ '), '0.00 ');
assert.equal(formatValue(-2e-7, '#,##0.00'), '-0.00');
assert.equal(formatValue(46332, formatCode(72, new Map())), '2026/11/6'); // 另一区域设置保存的内置格式 60/67/72 = 0.00/0%/日期
assert.equal(formatValue(0.5, formatCode(67, new Map())), '50%');
assert.equal(formatValue(3359.85, formatCode(60, new Map())), '3359.85');
assert.throws(() => formatValue(1, 'yyyy/m/d h:mm'), /时间/);
assert.throws(() => formatValue(1, '[>=100]0'), /方括号/);

// 7. 版面：每页行列、数值格式、文字溢出到空白相邻格
const plan = buildPlan(weekly.pkg, '授信周报', pageAreas(weekly.pkg, weekly.sheet.part));
assert.equal(plan.pages.length, 2);
assert.equal(plan.pages[0].rows.length, 10);
assert.equal(plan.pages[1].rows.length, 3);
const d3 = plan.pages[0].cells.find(c => c.row === 2 && c.col === 2);
assert.equal(d3.runs[0].text, '3606.85 ');
assert.equal(d3.h, 'right');
const header = plan.pages[1].cells.find(c => c.row === 0 && c.col === 0);
assert.equal(header.runs[0].text, '银行性质');
assert.equal(header.xr, 4); // C21:F21 为空，向右溢出到区域边缘

// 8. PDF：渲染器随 macOS 自带的 swiftc 编译，没有时跳过
if (process.platform === 'darwin' && !spawnSync('swiftc', ['--version']).error) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-weekly-selftest-'));
  try {
    const pdf = path.join(dir, 'weekly.pdf');
    renderPdf(plan, pdf);
    const bytes = fs.readFileSync(pdf, 'latin1');
    assert.match(bytes, /^%PDF-/);
    assert.equal((bytes.match(/\/Type\s*\/Page(?![s\w])/g) || []).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('credit-weekly selftest ok');
