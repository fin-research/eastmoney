// 把已转数值的工作表解析成「版面描述」：每页的列宽、行高、单元格（文字分段、填充、边框、对齐）。
// 由 render.swift 直接绘成 PDF，不依赖 Office/LibreOffice。覆盖本周报用到的样式；遇到不认识的数字格式抛错。
import { attr, findSheet, parseSection, sstOf, str, unescapeXml, splitRef } from './ooxml.mjs';
import { formatCode, formatValue } from './numfmt.mjs';

const TINT = (c, tint) => c.map(v => Math.round(tint < 0 ? v * (1 + tint) : v + (255 - v) * tint));
const hex = c => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const INDEXED = { 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF', 64: '000000' };

function themeColors(pkg) {
  const xml = pkg.has('xl/theme/theme1.xml') ? str(pkg, 'xl/theme/theme1.xml') : '';
  const scheme = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0] ?? '';
  const get = name => { const m = new RegExp(`<a:${name}>[\\s\\S]*?(?:val|lastClr)="([0-9A-Fa-f]{6})"`).exec(scheme); return m?.[1] ?? null; };
  const [dk1, lt1, dk2, lt2, ...acc] = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(get);
  return [lt1 ?? 'FFFFFF', dk1 ?? '000000', lt2 ?? 'EEECE1', dk2 ?? '1F497D', ...acc];
}

const rgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));

/** <color rgb|theme|indexed|auto tint> → 'RRGGBB'，auto/缺省返回 fallback。 */
function color(tag, theme, fallback) {
  if (!tag) return fallback;
  const tint = Number(attr(tag, 'tint') ?? 0), apply = h => (h && tint ? hex(TINT(rgb(h), tint)) : h);
  const v = attr(tag, 'rgb');
  if (v) return apply(v.slice(-6));
  const t = attr(tag, 'theme');
  if (t !== null) return theme[Number(t)] ? apply(theme[Number(t)]) : fallback;
  const i = attr(tag, 'indexed');
  if (i !== null) return INDEXED[Number(i)] ?? fallback;
  return fallback;
}

function styleTables(pkg) {
  const st = str(pkg, 'xl/styles.xml'), theme = themeColors(pkg);
  const list = (tag, child) => parseSection(st, tag, child)?.items ?? [];
  const custom = new Map(list('numFmts', 'numFmt').map(n => [Number(attr(n, 'numFmtId')), attr(n, 'formatCode')]));
  const font = xml => ({
    name: /<name val="([^"]*)"/.exec(xml)?.[1] ?? '等线', size: Number(/<sz val="([\d.]+)"/.exec(xml)?.[1] ?? 11),
    bold: /<b\s*\/>|<b val="(1|true)"/.test(xml), italic: /<i\s*\/>|<i val="(1|true)"/.test(xml),
    color: color(/<color [^>]*>/.exec(xml)?.[0], theme, '000000'),
  });
  const fill = xml => /patternType="solid"/.test(xml) ? color(/<fgColor [^>]*>/.exec(xml)?.[0], theme, null) : null;
  const WIDTH = { hair: 0.4, thin: 0.75, dotted: 0.75, dashed: 0.75, medium: 1.5, thick: 2.25, double: 1.5 };
  const border = xml => Object.fromEntries(['left', 'right', 'top', 'bottom'].map(side => {
    const m = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(xml);
    const style = m && attr(m[1], 'style');
    return [side, style ? { w: WIDTH[style] ?? 0.75, color: color(/<color [^>]*>/.exec(m[2] ?? '')?.[0], theme, '000000') } : null];
  }));
  const fonts = list('fonts', 'font').map(font), fills = list('fills', 'fill').map(fill), borders = list('borders', 'border').map(border);
  const xfs = list('cellXfs', 'xf').map(xml => {
    const open = /<xf\b[^>]*>/.exec(xml)[0], al = /<alignment\b[^>]*>/.exec(xml)?.[0] ?? '';
    return {
      font: fonts[Number(attr(open, 'fontId') ?? 0)], fill: fills[Number(attr(open, 'fillId') ?? 0)], border: borders[Number(attr(open, 'borderId') ?? 0)],
      numFmtId: Number(attr(open, 'numFmtId') ?? 0),
      h: attr(al, 'horizontal') ?? 'general', v: attr(al, 'vertical') ?? 'bottom', wrap: attr(al, 'wrapText') === '1',
    };
  });
  const dxfs = list('dxfs', 'dxf').map(xml => ({
    fill: (() => { const f = /<fill>[\s\S]*?<\/fill>/.exec(xml)?.[0]; return f ? color(/<bgColor [^>]*>/.exec(f)?.[0] ?? /<fgColor [^>]*>/.exec(f)?.[0], theme, null) : null; })(),
    fontColor: color(/<font>[\s\S]*?(<color [^>]*>)[\s\S]*?<\/font>/.exec(xml)?.[1], theme, null),
    bold: /<font>[\s\S]*?<b val="0"\s*\/>/.test(xml) ? false : /<font>[\s\S]*?<b\s*\/>/.test(xml) ? true : null,
  }));
  return { xfs, dxfs, theme, custom, defaultFont: fonts[0] };
}

const parseRange = ref => {
  const [a, b = a] = ref.split(':'), p = splitRef(a.replace(/\$/g, '')), q = splitRef(b.replace(/\$/g, ''));
  return { c1: p.colNo, r1: p.row, c2: q.colNo, r2: q.row };
};
const inRange = (rg, c, r) => c >= rg.c1 && c <= rg.c2 && r >= rg.r1 && r <= rg.r2;

function dateSerial(text) { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text.trim()); return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null; }
const operand = text => { const n = Number(text); return Number.isFinite(n) && text.trim() !== '' ? n : dateSerial(text); };

function ruleHolds(rule, value, row, warn) {
  if (rule.type === 'expression') {
    const m = /^MOD\(ROW\(\),(\d+)\)\s*(>|=|>=)\s*(\d+)$/.exec(rule.formulas[0].trim());
    if (!m) { warn(`跳过无法解析的条件格式公式：${rule.formulas[0]}`); return false; }
    const r = row % Number(m[1]), n = Number(m[3]);
    return m[2] === '>' ? r > n : m[2] === '=' ? r === n : r >= n;
  }
  if (rule.type !== 'cellIs') { warn(`跳过不支持的条件格式类型：${rule.type}`); return false; }
  const a = operand(rule.formulas[0] ?? ''), b = operand(rule.formulas[1] ?? '');
  if (a === null) { warn(`跳过无法解析的条件格式取值：${rule.formulas[0]}`); return false; }
  if (typeof value !== 'number') return ['greaterThan', 'greaterThanOrEqual', 'notEqual'].includes(rule.operator); // Excel 里文本大于任何数字
  switch (rule.operator) {
    case 'lessThan': return value < a;
    case 'lessThanOrEqual': return value <= a;
    case 'greaterThan': return value > a;
    case 'greaterThanOrEqual': return value >= a;
    case 'equal': return value === a;
    case 'notEqual': return value !== a;
    case 'between': return value >= a && value <= b;
    case 'notBetween': return value < a || value > b;
    default: warn(`跳过不支持的条件格式运算：${rule.operator}`); return false;
  }
}

function conditionalRules(xml) {
  const rules = [];
  for (const block of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const ranges = (attr(block[1], 'sqref') ?? '').split(/\s+/).filter(Boolean).map(parseRange);
    for (const r of block[2].matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
      rules.push({ ranges, type: attr(r[1], 'type'), operator: attr(r[1], 'operator'), dxfId: Number(attr(r[1], 'dxfId') ?? -1), priority: Number(attr(r[1], 'priority') ?? 0), formulas: [...(r[2] ?? '').matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map(f => unescapeXml(f[1])) });
    }
  }
  return rules.sort((a, b) => a.priority - b.priority);
}

/** 共享字符串条目 → 文字分段（保留富文本里每段的字体、颜色、粗体）。 */
function runsOf(si, base) {
  si = si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const parts = [...si.matchAll(/<r>([\s\S]*?)<\/r>/g)];
  if (!parts.length) return [{ text: [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join(''), ...base }];
  return parts.map(m => {
    const rpr = /<rPr>([\s\S]*?)<\/rPr>/.exec(m[1])?.[1] ?? '';
    return {
      text: [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescapeXml(t[1])).join(''),
      name: /<rFont val="([^"]*)"/.exec(rpr)?.[1] ?? base.name, size: Number(/<sz val="([\d.]+)"/.exec(rpr)?.[1] ?? base.size),
      bold: rpr ? /<b\s*\/>|<b val="(1|true)"/.test(rpr) : base.bold, italic: rpr ? /<i\s*\/>|<i val="(1|true)"/.test(rpr) : base.italic,
      color: color(/<color [^>]*>/.exec(rpr)?.[0], base.theme, base.color),
    };
  });
}

/**
 * @param areas  ['B1:H59', 'B63:F189']，每个区域一页
 * @returns {{pages: object[], warnings: string[]}}
 */
export function buildPlan(pkg, sheetName, areas) {
  const sheet = findSheet(pkg, sheetName), xml = str(pkg, sheet.part), tables = styleTables(pkg), sst = sstOf(pkg), warnings = [];
  const warn = msg => { if (!warnings.includes(msg)) warnings.push(msg); };
  const mdw = Math.ceil(tables.defaultFont.size / 2); // 列宽单位：默认字体数字宽度（点）
  const defaultRow = Number(/<sheetFormatPr\b[^>]*\sdefaultRowHeight="([\d.]+)"/.exec(xml)?.[1] ?? 15);
  const defaultCol = Number(/<sheetFormatPr\b[^>]*\sdefaultColWidth="([\d.]+)"/.exec(xml)?.[1] ?? 10.83);

  const colWidth = new Map();
  for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
    const min = Number(attr(m[0], 'min')), max = Number(attr(m[0], 'max')), hidden = attr(m[0], 'hidden') === '1';
    for (let c = min; c <= Math.min(max, 64); c++) colWidth.set(c, hidden ? 0 : Number(attr(m[0], 'width') ?? defaultCol) * mdw);
  }
  const rowInfo = new Map(), cellMap = new Map();
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const open = /<row\b[^>]*>/.exec(row[0])[0], r = Number(attr(open, 'r'));
    const ht = attr(open, 'ht');
    let fontMax = 0; // 无 ht 的行由 Excel 打开时按最大字号自动行高（宋体 36 号 → 46），其他软件另存的文件会丢掉 ht
    rowInfo.set(r, attr(open, 'hidden') === '1' ? 0 : ht !== null ? Number(ht) : defaultRow);
    for (const c of row[0].matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const cOpen = /<c\b[^>]*>/.exec(c[0])[0], p = splitRef(attr(cOpen, 'r'));
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[0]), t = attr(cOpen, 't') ?? 'n';
      let value;
      if (t === 's' && v) value = { si: sst.items[Number(v[1])] };
      else if (t === 'inlineStr') value = { si: /<is>([\s\S]*?)<\/is>/.exec(c[0])?.[0] ?? '' };
      else if (v && t === 'n') value = Number(v[1]);
      else if (v && t === 'b') value = v[1] === '1' ? 'TRUE' : 'FALSE';
      else if (v) value = unescapeXml(v[1]);
      const xf = tables.xfs[Number(attr(cOpen, 's') ?? 0)];
      if (!xf) throw new Error(`单元格 ${attr(cOpen, 'r')} 引用了不存在的样式`);
      cellMap.set(`${p.colNo},${p.row}`, { xf, value });
      if (value !== undefined) fontMax = Math.max(fontMax, xf.font.size ?? 0);
    }
    if (ht === null && rowInfo.get(r) > 0) rowInfo.set(r, Math.max(defaultRow, Math.round(fontMax * 1.28)));
  }
  const merges = [...xml.matchAll(/<mergeCell\b[^>]*>/g)].map(m => parseRange(attr(m[0], 'ref')));
  const rules = conditionalRules(xml);

  const pages = areas.map(ref => {
    const area = parseRange(ref);
    const cols = [], rows = [];
    for (let c = area.c1; c <= area.c2; c++) cols.push(colWidth.get(c) ?? defaultCol * mdw);
    for (let r = area.r1; r <= area.r2; r++) rows.push(rowInfo.get(r) ?? defaultRow);
    const cells = [];
    for (let r = area.r1; r <= area.r2; r++) {
      for (let c = area.c1; c <= area.c2; c++) {
        const merge = merges.find(m => inRange(m, c, r));
        if (merge && (Math.max(merge.c1, area.c1) !== c || Math.max(merge.r1, area.r1) !== r)) continue;
        const span = merge ? { c1: Math.max(merge.c1, area.c1), r1: Math.max(merge.r1, area.r1), c2: Math.min(merge.c2, area.c2), r2: Math.min(merge.r2, area.r2) } : { c1: c, r1: r, c2: c, r2: r };
        const cell = cellMap.get(`${c},${r}`);
        const edge = (cc, rr) => cellMap.get(`${cc},${rr}`)?.xf.border;
        const b = { left: edge(span.c1, span.r1)?.left, top: edge(span.c1, span.r1)?.top, right: edge(span.c2, span.r1)?.right, bottom: edge(span.c1, span.r2)?.bottom };
        const xf = cell?.xf;
        let fill = xf?.fill ?? null, fontColor = xf?.font.color, bold = xf?.font.bold;
        const text = cell?.value;
        const numeric = typeof text === 'number';
        let fillSet = false, fontSet = false, boldSet = false;
        for (const rule of rules) { // 优先级靠前的先生效，每个属性只取第一条命中的规则
          if (!rule.ranges.some(rg => inRange(rg, c, r)) || rule.dxfId < 0 || !ruleHolds(rule, numeric ? text : text === undefined ? 0 : 'text', r, warn)) continue;
          const d = tables.dxfs[rule.dxfId];
          if (!d) throw new Error(`条件格式引用了不存在的样式 ${rule.dxfId}`);
          if (d.fill && !fillSet) { fill = d.fill; fillSet = true; }
          if (d.fontColor && !fontSet) { fontColor = d.fontColor; fontSet = true; }
          if (d.bold !== null && !boldSet) { bold = d.bold; boldSet = true; }
        }
        const hasBorder = Object.values(b).some(Boolean);
        if (text === undefined && !fill && !hasBorder) continue;
        const base = { name: xf?.font.name ?? '等线', size: xf?.font.size ?? 11, bold: bold ?? false, italic: xf?.font.italic ?? false, color: fontColor ?? '000000', theme: tables.theme };
        let runs = [];
        if (text !== undefined) {
          if (typeof text === 'object') runs = runsOf(text.si, base);
          else runs = [{ text: numeric ? formatValue(text, formatCode(xf.numFmtId, tables.custom)) : text, ...base }];
        }
        runs = runs.map(({ theme, ...r }) => r);
        const h = xf?.h === 'general' || !xf ? (numeric ? 'right' : 'left') : xf.h;
        // 不换行的文字：相邻单元格为空时向外溢出（左对齐向右，右对齐向左，居中两侧对称）
        let xl = 0, xr = 0;
        if (typeof text === 'object' || typeof text === 'string') {
          const empty = cc => cc >= area.c1 && cc <= area.c2 && cellMap.get(`${cc},${r}`)?.value === undefined && !merges.some(m => inRange(m, cc, r));
          if (!(xf?.wrap) && span.c1 === span.c2) {
            while (empty(c - xl - 1)) xl++;
            while (empty(c + xr + 1)) xr++;
            if (h === 'left') xl = 0; else if (h === 'right') xr = 0; else xl = xr = Math.min(xl, xr);
          }
        }
        cells.push({ row: r - area.r1, col: c - area.c1, rs: span.r2 - span.r1 + 1, cs: span.c2 - span.c1 + 1, xl, xr, runs, fill, h, v: xf?.v ?? 'bottom', wrap: xf?.wrap ?? false, bl: b.left, br: b.right, bt: b.top, bb: b.bottom });
      }
    }
    return { cols, rows, cells };
  });
  return { pages, warnings };
}
