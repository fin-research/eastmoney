// 直接操作 xlsx（OOXML）：拆出单个 sheet、公式转数值、把 sheet 带样式并入另一个工作簿、设置打印区域。
// 不依赖第三方库；对未触及的部件原样保留，避免 Excel 往返损失。
import path from 'node:path';

const posix = path.posix;
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const escapeXml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescapeXml(m[1]) : null; };
const setAttr = (tag, name, value) => {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  if (value == null) return tag.replace(re, '');
  const text = ` ${name}="${escapeXml(String(value))}"`;
  return re.test(tag) ? tag.replace(re, text) : tag.replace(/(\/?>)$/, `${text}$1`);
};
export const str = (pkg, name) => { const b = pkg.get(name); if (!b) throw new Error(`xlsx 缺少部件：${name}`); return b.toString('utf8'); };
const put = (pkg, name, xml) => pkg.set(name, Buffer.from(xml, 'utf8'));

export const clonePackage = pkg => new Map(pkg);
export const relsPath = part => posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
const resolveTarget = (base, target) => target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(base), target));

export function parseRels(xml) {
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map(m => ({ tag: m[0], id: attr(m[0], 'Id'), type: attr(m[0], 'Type'), target: attr(m[0], 'Target'), external: attr(m[0], 'TargetMode') === 'External' }));
}

export function workbookPart(pkg) {
  const rel = parseRels(str(pkg, '_rels/.rels')).find(r => /\/officeDocument$/.test(r.type));
  if (!rel) throw new Error('xlsx 缺少 workbook 关系');
  return rel.target.replace(/^\//, '');
}

/** 工作表清单（按 workbook 顺序）：name、sheetId、rid、part。 */
export function listSheets(pkg) {
  const wb = workbookPart(pkg), rels = parseRels(str(pkg, relsPath(wb)));
  return [...str(pkg, wb).matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const rid = attr(m[0], 'r:id'), rel = rels.find(r => r.id === rid);
    if (!rel) throw new Error(`工作表缺少关系：${attr(m[0], 'name')}`);
    return { name: attr(m[0], 'name'), sheetId: Number(attr(m[0], 'sheetId')), rid, part: resolveTarget(wb, rel.target), tag: m[0] };
  });
}

export function findSheet(pkg, name) {
  const sheet = listSheets(pkg).find(s => s.name === name);
  if (!sheet) throw new Error(`xlsx 里找不到工作表「${name}」`);
  return sheet;
}

// ---------- 通用段落切分（styles / sharedStrings） ----------

function splitChildren(inner, child) {
  const items = [], re = new RegExp(`<${child}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  let m;
  while ((m = re.exec(inner))) {
    if (m[1]) { items.push(m[0]); continue; }
    const close = inner.indexOf(`</${child}>`, re.lastIndex), end = close + child.length + 3;
    items.push(inner.slice(m.index, end));
    re.lastIndex = end;
  }
  return items;
}

export function parseSection(xml, tag, child) {
  const m = new RegExp(`<${tag}(?=[\\s>/])([^>]*?)(/?)>`).exec(xml);
  if (!m) return null;
  const start = m.index;
  if (m[2]) return { start, end: start + m[0].length, attrs: m[1], items: [] };
  const close = xml.indexOf(`</${tag}>`, start);
  return { start, end: close + tag.length + 3, attrs: m[1], items: splitChildren(xml.slice(start + m[0].length, close), child) };
}

function writeSection(xml, section, tag, items) {
  const attrs = /\scount="\d+"/.test(section.attrs) ? section.attrs.replace(/\scount="\d+"/, ` count="${items.length}"`) : `${section.attrs} count="${items.length}"`;
  return `${xml.slice(0, section.start)}<${tag}${attrs}>${items.join('')}</${tag}>${xml.slice(section.end)}`;
}

// ---------- 共享字符串 ----------

export class SharedStrings {
  constructor(xml) {
    this.xml = xml;
    this.items = [...xml.matchAll(/<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g)].map(m => m[0]);
    this.index = new Map(this.items.map((s, i) => [s, i]));
    this.added = 0;
  }
  text(i) { return [...(this.items[i] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join(''); }
  add(si) { let i = this.index.get(si); if (i === undefined) { i = this.items.length; this.items.push(si); this.index.set(si, i); } this.added++; return i; }
  addText(escaped) { return this.add(`<si><t xml:space="preserve">${escaped}</t></si>`); }
  toXml() {
    const open = /<sst\b[^>]*>/.exec(this.xml)[0];
    const count = Number(attr(open, 'count') ?? this.items.length) + this.added;
    const head = setAttr(setAttr(open, 'count', count), 'uniqueCount', this.items.length);
    return `${this.xml.slice(0, this.xml.indexOf(open))}${head}${this.items.join('')}</sst>`;
  }
}

export function sstOf(pkg) {
  if (!pkg.has('xl/sharedStrings.xml')) throw new Error('xlsx 缺少 sharedStrings.xml');
  return new SharedStrings(str(pkg, 'xl/sharedStrings.xml'));
}

// ---------- 单元格读取（排版判断用） ----------

/** @returns {{cells: Map<string, {t: string, v: string|number|null}>, rows: Map<number, {hidden: boolean}>}} */
export function readCells(pkg, sheetPart) {
  const xml = str(pkg, sheetPart), sst = pkg.has('xl/sharedStrings.xml') ? sstOf(pkg) : null;
  const cells = new Map(), rows = new Map();
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const open = /<row\b[^>]*>/.exec(row[0])[0], r = Number(attr(open, 'r'));
    rows.set(r, { hidden: attr(open, 'hidden') === '1' });
    for (const c of row[0].matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const cOpen = /<c\b[^>]*>/.exec(c[0])[0], ref = attr(cOpen, 'r'), t = attr(cOpen, 't') ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[0]);
      let value = null;
      if (t === 's' && v) value = sst.text(Number(v[1]));
      else if (t === 'inlineStr') value = [...c[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');
      else if (v) value = t === 'n' ? Number(v[1]) : unescapeXml(v[1]);
      if (value !== null && value !== '') cells.set(ref, { t, v: value });
    }
  }
  return { cells, rows };
}

export const colIndex = letters => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const splitRef = ref => { const m = /^([A-Z]+)(\d+)$/.exec(ref); return { col: m[1], colNo: colIndex(m[1]), row: Number(m[2]) }; };
export const excelDate = serial => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);

// ---------- 公式转数值 ----------

/**
 * 去掉公式、保留缓存值。crossSheetOnly=true 时只处理引用其他工作表的公式（含 '!'），
 * 同表公式原样保留。公式字符串结果（t="str"）转成共享字符串。
 */
export function stripFormulas(xml, sst, { crossSheetOnly = false } = {}) {
  const sharedDrop = new Set();
  if (crossSheetOnly) {
    for (const m of xml.matchAll(/<f\b([^>]*)>([^<]*)<\/f>/g)) {
      if (attr(m[1], 't') === 'shared' && m[2].includes('!')) sharedDrop.add(attr(m[1], 'si'));
    }
  }
  const dropIt = (open, body) => !crossSheetOnly || body.includes('!') || (attr(open, 't') === 'shared' && sharedDrop.has(attr(open, 'si')));
  let dropped = 0;
  const out = xml.replace(/<c(?=[\s>])[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, cell => {
    const f = /<f(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell);
    if (!f || !dropIt(f[1], f[2] ?? '')) return cell;
    dropped++;
    let next = cell.replace(f[0], '');
    const open = /<c\b[^>]*>/.exec(next)[0];
    let tag = setAttr(open, 'cm', null);
    if (attr(tag, 't') === 'str') {
      const v = /<v>([\s\S]*?)<\/v>/.exec(next);
      if (v && sst) { tag = setAttr(tag, 't', 's'); next = next.replace(v[0], `<v>${sst.addText(v[1])}</v>`); }
      else if (v) { tag = setAttr(tag, 't', 'inlineStr'); next = next.replace(v[0], `<is><t xml:space="preserve">${v[1]}</t></is>`); }
      else tag = setAttr(tag, 't', null);
    }
    return next.replace(open, tag);
  });
  return { xml: out, dropped };
}

// ---------- 工作表 XML 整理 ----------

function tagEdit(xml, name, fn) { return xml.replace(new RegExp(`<${name}(?=[\\s>/])[^>]*>`), fn); }

/** 工作表末尾直接挂在 <worksheet> 下的 extLst（不是 cfRule 等内部的）。 */
function sheetExtLst(xml) {
  const end = xml.lastIndexOf('</worksheet>'), close = xml.lastIndexOf('</extLst>', end);
  if (close < 0 || xml.slice(close + 9, end).trim()) return null;
  const start = xml.lastIndexOf('<extLst>', close);
  return start < 0 ? null : { start, end: close + 9, inner: xml.slice(start + 8, close) };
}

const reEscapeName = s => s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');
/** 文本里是否按名字引用了某个工作表（sheet! 或 'sheet'!，前面不能是名字字符）。 */
export const refsSheet = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}_.])'?${reEscapeName(name)}'?!`, 'u').test(text);

/** 去掉 uid、codeName；dropObjects 时去掉批注/绘图/超链接引用（并入别的工作簿时没有对应关系部件）；设置选中状态。 */
export function normalizeSheet(xml, { selected, dropExt = false, dropObjects = false, removedSheets = [] } = {}) {
  let out = tagEdit(xml, 'worksheet', t => setAttr(t, 'xr:uid', null));
  out = out.replace(/(<sheetPr\b[^>]*?)\scodeName="[^"]*"/, '$1');
  if (dropObjects) {
    out = out.replace(/<legacyDrawing(?:HF)?\b[^>]*\/>|<drawing\b[^>]*\/>|<picture\b[^>]*\/>|<tableParts\b[\s\S]*?<\/tableParts>|<hyperlinks>[\s\S]*?<\/hyperlinks>|<oleObjects>[\s\S]*?<\/oleObjects>|<controls>[\s\S]*?<\/controls>/g, '');
    out = out.replace(/<pageSetup\b[^>]*>/, t => setAttr(t, 'r:id', null));
    if (/\sr:id="/.test(out)) throw new Error('工作表仍含对其他部件的引用（r:id），无法并入');
  }
  out = out.replace(/<sheetView\b[^>]*>/, t => setAttr(setAttr(t, 'tabSelected', selected ? '1' : null), 'topLeftCell', null));
  if (selected && !/<pane\b/.test(out)) out = out.replace(/<selection\b[^>]*\/>/g, '').replace(/(<sheetView\b[^>]*[^/]>)/, '$1<selection activeCell="A1" sqref="A1"/>');
  const ext = sheetExtLst(out);
  if (dropExt && ext) out = out.slice(0, ext.start) + out.slice(ext.end);
  else if (removedSheets.length && ext) {
    const kept = [...ext.inner.matchAll(/<ext\b[\s\S]*?<\/ext>/g)].map(m => m[0]).filter(e => !removedSheets.some(n => refsSheet(e, n)));
    out = out.slice(0, ext.start) + (kept.length ? `<extLst>${kept.join('')}</extLst>` : '') + out.slice(ext.end);
  }
  return out;
}

// ---------- 拆出单个 sheet 的独立工作簿 ----------

function reachableParts(pkg) {
  const seen = new Set(['[Content_Types].xml']), queue = [''];
  while (queue.length) {
    const owner = queue.pop(), rels = owner ? relsPath(owner) : '_rels/.rels';
    if (!pkg.has(rels)) continue;
    seen.add(rels);
    for (const r of parseRels(str(pkg, rels))) {
      if (r.external) continue;
      const target = owner ? resolveTarget(owner, r.target) : r.target.replace(/^\//, '');
      if (pkg.has(target) && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

const reEscape = s => s.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&');

function dropPart(pkg, part) {
  pkg.delete(part);
  const ct = str(pkg, '[Content_Types].xml');
  put(pkg, '[Content_Types].xml', ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${reEscape(part)}"[^>]*/>`), ''));
}

/**
 * 只保留一个工作表（含其样式、字符串、批注等依赖），其余工作表和 calcChain 删除。
 * formulas: 'keep'（保留同表公式、跨表公式转值）| 'values'（全部转值）
 */
export function extractSheet(pkg, name, { formulas = 'values' } = {}) {
  const out = clonePackage(pkg), sheets = listSheets(pkg), keep = sheets.find(s => s.name === name);
  if (!keep) throw new Error(`xlsx 里找不到工作表「${name}」`);
  const wb = workbookPart(pkg), removed = sheets.filter(s => s !== keep), removedNames = removed.map(s => s.name);
  let wbXml = str(out, wb);
  const keepIndex = sheets.indexOf(keep);

  wbXml = wbXml.replace(/<sheets>[\s\S]*<\/sheets>/, `<sheets>${keep.tag}</sheets>`);
  wbXml = wbXml.replace(/<definedNames>([\s\S]*?)<\/definedNames>/, (all, inner) => {
    const kept = [...inner.matchAll(/<definedName\b[^>]*>[\s\S]*?<\/definedName>|<definedName\b[^>]*\/>/g)].map(m => m[0]).filter(d => {
      const local = attr(d, 'localSheetId');
      if (local !== null) return Number(local) === keepIndex;
      return !removedNames.some(n => refsSheet(d, n));
    }).map(d => /\slocalSheetId="\d+"/.test(d) ? d.replace(/\slocalSheetId="\d+"/, ' localSheetId="0"') : d);
    return kept.length ? `<definedNames>${kept.join('')}</definedNames>` : '';
  });
  wbXml = wbXml.replace(/<workbookView\b[^>]*>/, t => setAttr(setAttr(t, 'activeTab', null), 'firstSheet', null));
  put(out, wb, wbXml);

  let rels = str(out, relsPath(wb));
  for (const r of parseRels(rels)) {
    if ((/\/worksheet$/.test(r.type) && r.id !== keep.rid) || /\/calcChain$/.test(r.type)) rels = rels.replace(r.tag, '');
  }
  put(out, relsPath(wb), rels);
  const rootRels = parseRels(str(out, '_rels/.rels'));
  const app = rootRels.find(r => /extended-properties$/.test(r.type));
  if (app) put(out, '_rels/.rels', str(out, '_rels/.rels').replace(app.tag, ''));

  const live = reachableParts(out);
  for (const part of [...out.keys()]) if (!live.has(part)) dropPart(out, part);

  const sst = out.has('xl/sharedStrings.xml') ? sstOf(out) : null;
  let xml = str(out, keep.part), dropped = 0;
  if (formulas !== 'none') {
    const stripped = stripFormulas(xml, sst, { crossSheetOnly: formulas === 'keep' });
    xml = stripped.xml; dropped = stripped.dropped;
  }
  xml = normalizeSheet(xml, { selected: true, dropExt: formulas === 'values', removedSheets: removedNames });
  put(out, keep.part, xml);
  if (sst) put(out, 'xl/sharedStrings.xml', sst.toXml());
  return { pkg: out, sheet: keep, droppedFormulas: dropped };
}

// ---------- 样式合并 ----------

function mergeStyles(srcPkg, dstPkg, usedXf, usedDxf) {
  const src = str(srcPkg, 'xl/styles.xml');
  let dst = str(dstPkg, 'xl/styles.xml');
  const list = (xml, tag, child) => parseSection(xml, tag, child)?.items ?? [];
  const srcFonts = list(src, 'fonts', 'font'), srcFills = list(src, 'fills', 'fill'), srcBorders = list(src, 'borders', 'border');
  const srcXfs = list(src, 'cellXfs', 'xf'), srcDxfs = list(src, 'dxfs', 'dxf'), srcNumFmts = list(src, 'numFmts', 'numFmt');
  const srcCode = new Map(srcNumFmts.map(n => [Number(attr(n, 'numFmtId')), attr(n, 'formatCode')]));

  const pools = {
    fonts: list(dst, 'fonts', 'font'), fills: list(dst, 'fills', 'fill'), borders: list(dst, 'borders', 'border'),
    cellXfs: list(dst, 'cellXfs', 'xf'), dxfs: list(dst, 'dxfs', 'dxf'), numFmts: list(dst, 'numFmts', 'numFmt'),
  };
  const intern = (pool, item) => { const i = pool.indexOf(item); if (i >= 0) return i; pool.push(item); return pool.length - 1; };
  const dstCode = new Map(pools.numFmts.map(n => [attr(n, 'formatCode'), Number(attr(n, 'numFmtId'))]));
  let nextFmt = Math.max(163, ...pools.numFmts.map(n => Number(attr(n, 'numFmtId')))) + 1;
  const numFmt = id => {
    if (id < 164) return id;
    const code = srcCode.get(id);
    if (code == null) throw new Error(`样式引用了未定义的数字格式 ${id}`);
    if (!dstCode.has(code)) { dstCode.set(code, nextFmt); pools.numFmts.push(`<numFmt numFmtId="${nextFmt}" formatCode="${escapeXml(code)}"/>`); nextFmt++; }
    return dstCode.get(code);
  };

  const xfMap = new Map();
  for (const id of [...usedXf].sort((a, b) => a - b)) {
    const xf = srcXfs[id];
    if (!xf) throw new Error(`工作表引用了不存在的单元格样式 ${id}`);
    let open = /<xf\b[^>]*>/.exec(xf)[0], next = open;
    next = setAttr(next, 'fontId', intern(pools.fonts, srcFonts[Number(attr(open, 'fontId') ?? 0)]));
    next = setAttr(next, 'fillId', intern(pools.fills, srcFills[Number(attr(open, 'fillId') ?? 0)]));
    next = setAttr(next, 'borderId', intern(pools.borders, srcBorders[Number(attr(open, 'borderId') ?? 0)]));
    next = setAttr(next, 'numFmtId', numFmt(Number(attr(open, 'numFmtId') ?? 0)));
    next = setAttr(next, 'xfId', 0);
    xfMap.set(id, intern(pools.cellXfs, xf.replace(open, next)));
  }
  const dxfMap = new Map();
  for (const id of [...usedDxf].sort((a, b) => a - b)) {
    if (!srcDxfs[id]) throw new Error(`工作表引用了不存在的条件格式样式 ${id}`);
    dxfMap.set(id, intern(pools.dxfs, srcDxfs[id]));
  }

  const tags = { fonts: 'font', fills: 'fill', borders: 'border', cellXfs: 'xf', dxfs: 'dxf', numFmts: 'numFmt' };
  for (const [tag, child] of Object.entries(tags)) {
    let section = parseSection(dst, tag, child);
    if (!section) {
      if (tag === 'numFmts') { dst = dst.replace(/<fonts\b/, '<numFmts count="0"></numFmts><fonts'); section = parseSection(dst, tag, child); }
      else if (tag === 'dxfs') { dst = dst.replace(/(<\/cellStyles>)|(<tableStyles\b)/, (m, a, b) => a ? `${a}<dxfs count="0"></dxfs>` : `<dxfs count="0"></dxfs>${b}`); section = parseSection(dst, tag, child); }
      else throw new Error(`样式表缺少 ${tag}`);
    }
    dst = writeSection(dst, section, tag, pools[tag]);
  }
  put(dstPkg, 'xl/styles.xml', dst);
  return { xfMap, dxfMap };
}

/** 工作簿默认字体（font 0）；列宽以它为单位，并入前用来确认两边一致。 */
export function defaultFont(pkg) { return parseSection(str(pkg, 'xl/styles.xml'), 'fonts', 'font')?.items[0] ?? ''; }

// ---------- 并入目标工作簿 ----------

const sheetXmlIds = xml => {
  const xf = new Set(), dxf = new Set();
  for (const m of xml.matchAll(/<(?:c|row)(?=[\s>])[^>]*>/g)) { const s = attr(m[0], 's'); if (s !== null) xf.add(Number(s)); }
  for (const m of xml.matchAll(/<col(?=[\s>])[^>]*>/g)) { const s = attr(m[0], 'style'); if (s !== null) xf.add(Number(s)); }
  for (const m of xml.matchAll(/<c(?=[\s>])[^>]*>/g)) if (attr(m[0], 's') === null) xf.add(0);
  for (const m of xml.matchAll(/<cfRule\b[^>]*>/g)) { const d = attr(m[0], 'dxfId'); if (d !== null) dxf.add(Number(d)); }
  return { xf, dxf };
};

/**
 * 把 srcPkg 里已转为数值的工作表并入 dstPkg 的最前面；同名工作表则原位替换。
 * 返回 { replaced }。
 */
export function addValuesSheet(dstPkg, srcPkg, srcSheetName, newName) {
  const src = findSheet(srcPkg, srcSheetName), wb = workbookPart(dstPkg);
  const srcSst = sstOf(srcPkg), dstSst = sstOf(dstPkg);
  let xml = str(srcPkg, src.part);
  if (/<f(?=[\s>/])/.test(xml)) throw new Error('待并入的工作表仍含公式');

  const { xf, dxf } = sheetXmlIds(xml);
  const { xfMap, dxfMap } = mergeStyles(srcPkg, dstPkg, xf, dxf);
  xml = xml.replace(/<c(?=[\s>])[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, cell => {
    const open = /<c\b[^>]*>/.exec(cell)[0], old = attr(open, 's');
    let tag = setAttr(open, 's', xfMap.get(old === null ? 0 : Number(old)));
    let body = cell.slice(open.length);
    if (attr(open, 't') === 's') body = body.replace(/<v>(\d+)<\/v>/, (all, i) => `<v>${dstSst.add(srcSst.items[Number(i)])}</v>`);
    return tag + body;
  });
  for (const [re, name] of [[/<row(?=[\s>])[^>]*>/g, 's'], [/<col(?=[\s>])[^>]*>/g, 'style']]) {
    xml = xml.replace(re, t => { const v = attr(t, name); return v === null ? t : setAttr(t, name, xfMap.get(Number(v))); });
  }
  xml = xml.replace(/<cfRule\b[^>]*>/g, t => attr(t, 'dxfId') === null ? t : setAttr(t, 'dxfId', dxfMap.get(Number(attr(t, 'dxfId')))));
  xml = normalizeSheet(xml, { selected: true, dropExt: true, dropObjects: true });
  const scale = columnScale(srcPkg, dstPkg);
  if (scale !== 1) xml = xml.replace(/<col(?=[\s>])[^>]*>/g, t => attr(t, 'width') === null ? t : setAttr(t, 'width', Math.round(Number(attr(t, 'width')) * scale * 256) / 256));

  const sheets = listSheets(dstPkg), existing = sheets.find(s => s.name === newName);
  let wbXml = str(dstPkg, wb), part;
  if (existing) part = existing.part;
  else {
    const num = Math.max(0, ...[...dstPkg.keys()].map(k => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k)).filter(Boolean).map(m => Number(m[1]))) + 1;
    part = `xl/worksheets/sheet${num}.xml`;
    const rels = str(dstPkg, relsPath(wb)), parsed = parseRels(rels);
    const rid = `rId${Math.max(0, ...parsed.map(r => Number(/\d+$/.exec(r.id)?.[0] ?? 0))) + 1}`;
    const sheetId = Math.max(0, ...sheets.map(s => s.sheetId)) + 1;
    put(dstPkg, relsPath(wb), rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${posix.relative(posix.dirname(wb), part)}"/></Relationships>`));
    const ct = str(dstPkg, '[Content_Types].xml');
    put(dstPkg, '[Content_Types].xml', ct.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
    wbXml = wbXml.replace('<sheets>', `<sheets><sheet name="${escapeXml(newName)}" sheetId="${sheetId}" r:id="${rid}"/>`);
    wbXml = wbXml.replace(/<definedName\b[^>]*>/g, t => attr(t, 'localSheetId') === null ? t : setAttr(t, 'localSheetId', Number(attr(t, 'localSheetId')) + 1));
    bumpAppProps(dstPkg, newName);
  }
  wbXml = wbXml.replace(/<workbookView\b[^>]*>/, t => setAttr(t, 'activeTab', existing ? sheets.indexOf(existing) : 0));
  put(dstPkg, wb, wbXml);
  put(dstPkg, part, xml);
  for (const s of sheets) {
    if (s.part === part) continue;
    const head = str(dstPkg, s.part);
    if (/tabSelected="1"/.test(head)) put(dstPkg, s.part, head.replace(/(<sheetView\b[^>]*?)\stabSelected="1"/, '$1'));
  }
  put(dstPkg, 'xl/sharedStrings.xml', dstSst.toXml());
  return { replaced: Boolean(existing), part, columnScale: scale };
}

/**
 * 列宽单位是默认字体的数字宽度，两个工作簿默认字号不同时要换算才能保持物理宽度。
 * 数字宽度按 ceil(字号/2) 估算，对 10→11 号得 5/6，与 Excel 在样例里的换算一致。
 */
export function columnScale(srcPkg, dstPkg) {
  const size = pkg => Number(/<sz val="([\d.]+)"/.exec(defaultFont(pkg))?.[1] ?? 0);
  const a = size(srcPkg), b = size(dstPkg);
  return a && b && a !== b ? Math.ceil(a / 2) / Math.ceil(b / 2) : 1;
}

function bumpAppProps(pkg, name) {
  if (!pkg.has('docProps/app.xml')) return;
  let xml = str(pkg, 'docProps/app.xml');
  xml = xml.replace(/(<vt:lpstr>(?:工作表|Worksheets)<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)(\d+)/, (a, p, n) => `${p}${Number(n) + 1}`);
  xml = xml.replace(/(<TitlesOfParts><vt:vector size=")(\d+)(" baseType="lpstr">)/, (a, p, n, q) => `${p}${Number(n) + 1}${q}<vt:lpstr>${escapeXml(name)}</vt:lpstr>`);
  put(pkg, 'docProps/app.xml', xml);
}
