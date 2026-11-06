// Excel 数字格式化（够周报用）：数值、百分比、千分位、日期；认不出的格式码抛错，不静默出错。
const BUILTIN = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'yyyy/m/d', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 60: '0.00', 67: '0%', 72: 'yyyy/m/d' /* 另一区域设置下保存的文件把 2/9/14 写成 60/67/72，含义相同 */, 37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)', 49: '@' };
const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const SHORT_WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatCode(id, custom) { return custom.get(id) ?? BUILTIN[id] ?? (() => { throw new Error(`不认识的数字格式 ${id}`); })(); }

/** 把格式码拆成 [{lit}|{raw}] 记号：引号文本、转义字符、_x 空格归为 lit，其余字符保留为 raw。 */
function tokenize(section) {
  const out = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') { const j = section.indexOf('"', i + 1); out.push({ lit: section.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? section.length : j; }
    else if (ch === '\\') { out.push({ lit: section[++i] ?? '' }); }
    else if (ch === '_') { out.push({ lit: ' ' }); i++; }
    else if (ch === '*') { i++; }
    else if (ch === '[') {
      const j = section.indexOf(']', i), body = section.slice(i + 1, j);
      if (/^\$-F800$/i.test(body)) out.push({ raw: '[F800]' });
      else if (!/^(red|blue|green|black|white|yellow|magenta|cyan|color\s*\d+)$/i.test(body)) throw new Error(`不支持的数字格式（方括号内容 [${body}]）`);
      i = j < 0 ? section.length : j;
    }
    else out.push({ raw: ch });
  }
  return out;
}

const splitSections = code => { const parts = []; let cur = '', q = false; for (const ch of code) { if (ch === '"') q = !q; if (ch === ';' && !q) { parts.push(cur); cur = ''; } else cur += ch; } parts.push(cur); return parts; };
const roundTo = (x, d) => { const f = 10 ** d, r = Math.round(Math.abs(x) * f + 1e-9) / f; return x < 0 ? -r : r; };

function general(v) {
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toPrecision(10)));
}

function formatDate(serial, tokens) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate(), W = d.getUTCDay();
  const pad = n => String(n).padStart(2, '0');
  let out = '', raw = tokens.map(t => t.raw ?? '\u0000').join('');
  const long = raw.includes('[F800]');
  if (long) return `${Y}年${M}月${D}日 ${WEEKDAY[W]}`;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.lit !== undefined) { out += t.lit; continue; }
    const rest = tokens.slice(i).map(x => x.raw ?? '\u0000').join('');
    const m = /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|aaaa|aaa)/i.exec(rest);
    if (!m) { out += t.raw; continue; }
    const k = m[1].toLowerCase();
    out += { yyyy: Y, yy: pad(Y % 100), mmmm: `${M}月`, mmm: `${M}月`, mm: pad(M), m: M, dddd: WEEKDAY[W], aaaa: WEEKDAY[W], ddd: SHORT_WEEKDAY[W], aaa: SHORT_WEEKDAY[W], dd: pad(D), d: D }[k];
    i += k.length - 1;
  }
  return out;
}

function formatNumber(v, tokens, negative) {
  const isPlaceholder = t => t.raw !== undefined && /[#0?.,]/.test(t.raw);
  const first = tokens.findIndex(isPlaceholder);
  const keep = t => t.lit ?? (/[%()+\- ]/.test(t.raw) ? t.raw : '');
  if (first < 0) return tokens.map(keep).join('');
  let last = first;
  while (last + 1 < tokens.length && isPlaceholder(tokens[last + 1])) last++;
  const pattern = tokens.slice(first, last + 1).map(t => t.raw).join('');
  if (/,$/.test(pattern)) throw new Error(`不支持的数字格式（千倍缩放）：${pattern}`);
  const percent = tokens.some(t => t.raw === '%');
  const [intPat, decPat = ''] = pattern.split('.');
  const decimals = decPat.length, minInt = (intPat.match(/0/g) || []).length;
  let [ip, dp = ''] = roundTo(Math.abs(v) * (percent ? 100 : 1), decimals).toFixed(decimals).split('.');
  ip = ip.padStart(minInt, '0');
  if (ip === '0' && minInt === 0 && decimals > 0) ip = '';
  if (intPat.includes(',')) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = decimals ? `${ip}.${dp}` : ip;
  return (negative ? '-' : '') + tokens.slice(0, first).map(keep).join('') + body + tokens.slice(last + 1).map(keep).join('');
}

export function formatValue(value, code) {
  if (typeof value !== 'number') return String(value);
  if (code === 'General' || code === '@') return general(value);
  const sections = splitSections(code);
  const negative = value < 0 && sections.length < 2;
  const section = value < 0 && sections.length >= 2 ? sections[1] : value === 0 && sections.length >= 3 ? sections[2] : sections[0];
  const tokens = tokenize(section);
  const rawText = tokens.map(t => t.raw ?? '').join('');
  const isDate = /[ymd]/i.test(rawText.replace(/[^a-z]/gi, '')) && !/[#0]/.test(rawText) || tokens.some(t => t.raw === '[F800]');
  if (/[hs]/i.test(rawText.replace(/[^a-z]/gi, ''))) throw new Error(`不支持的时间格式：${code}`);
  if (isDate) return formatDate(value, tokens);
  if (/[a-z]/i.test(rawText.replace(/E[+-]/gi, ''))) throw new Error(`不支持的数字格式：${code}`);
  return formatNumber(value, tokens, negative && value < 0);
}
