import * as XLSX from 'xlsx';

const sheets = ['短融', '公募债', '公募次级债', '私募债'];
const subtypeBySheet = { 短融: '短期融资券', 公募债: '小公募', 公募次级债: '次级债', 私募债: '私募债' };
const text = value => value == null || String(value).trim() === '' ? null : String(value).trim();

function date(value) {
  if (typeof value === 'number') {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts) throw new Error('无效的 Excel 日期');
    return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  throw new Error(`缺少有效日期：${value}`);
}

export function clientFromInvestor(name, category) {
  if (name === '未知') return null;
  const types = {
    银行理财: ['理财子', name.includes('理财') ? '银行理财子公司' : '银行资管'],
    公募基金: ['基金', '公募基金'], 股份制银行: ['银行', '股份行'],
    国有银行: ['银行', '国有银行'], 城农商行: ['银行', name.includes('农商') ? '农商行' : '城商行'],
    券商资管: ['券商', '资管'], 券商自营: ['券商', '自营'],
    保险资管: ['其它', '保险资管'], 其他: ['其它', null]
  };
  if (!types[category]) throw new Error(`${name} 缺少机构分类`);
  const [type, subtype] = types[category];
  return { name, fullname: null, type, subtype };
}

export function parseBondInvestorWorkbook(bytes) {
  const book = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  const source = name => {
    if (!book.Sheets[name]) throw new Error(`缺少工作表：${name}`);
    const range = XLSX.utils.decode_range(book.Sheets[name]['!ref'] ?? 'A1');
    range.s = { r: 0, c: 0 };
    return XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null, blankrows: true, range });
  };
  const institutionRows = source('按投资机构');
  const reportDate = date(institutionRows[0]?.[3]);
  const institutions = institutionRows.slice(4).filter(row => row[1] && row[2]).map(row => ({ name: text(row[2]), category: text(row[1]), expectedTotal: row[3], expectedOutstanding: row[18] }));
  const categories = new Map();
  for (const item of institutions) {
    if (categories.has(item.name)) throw new Error(`重复投资机构：${item.name}`);
    categories.set(item.name, item.category);
  }
  const rows = [];
  for (const sheet of sheets) {
    const input = source(sheet);
    const amountIndex = sheet === '短融' ? 6 : 5;
    const issueIndex = sheet === '短融' ? 8 : 7;
    if (text(input[1]?.[1]) !== '债券简称' || text(input[1]?.[2]) !== '实际投资人') throw new Error(`${sheet} 表头不匹配`);
    let blockCents = 0;
    for (let index = 2; index < input.length; index++) {
      const row = input[index];
      if (row.slice(1, amountIndex + 1).every(value => value == null)) continue;
      const bondName = text(row[1]), investorName = text(row[2]), amount = row[amountIndex];
      if (bondName === '合计' && investorName === null) {
        if (typeof amount !== 'number' || Math.round(amount * 100) !== blockCents) throw new Error(`${sheet} 第${index + 1}行合计与明细不符`);
        blockCents = 0;
        continue;
      }
      if (!bondName || !investorName || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error(`${sheet} 第${index + 1}行缺少债券、投资人或有效金额`);
      if (!categories.has(investorName)) throw new Error(`${sheet} 第${index + 1}行投资人未在按投资机构表分类`);
      rows.push({ sheet, row: index + 1, bondName, investorName, category: categories.get(investorName), subtype: subtypeBySheet[sheet], channel: text(row[3]), account: text(row[4]), amount, issueDate: date(row[issueIndex]), maturityDate: date(row[issueIndex + 1]) });
      blockCents += Math.round(amount * 100);
    }
    if (blockCents !== 0) throw new Error(`${sheet} 末尾缺少合计行`);
  }
  if (!rows.length) throw new Error('投资人明细为空');
  const stats = source('统计');
  const structures = stats.slice(20, 29).map(row => ({ category: row[2], total: row.slice(3, 8), outstanding: row.slice(10, 15) }));
  const ranking = stats.slice(110).filter(row => typeof row[2] === 'string' && typeof row[3] === 'number').map(row => ({ name: row[2], total: row[3], outstanding: row[5] }));
  return { reportDate, rows, institutions, structures, ranking, controls: { total: stats[29]?.[7], outstanding: stats[29]?.[14], rankingTotal: stats[109]?.[3], rankingOutstanding: stats[109]?.[5], staticRankingTotal: stats[109]?.[9], staticRankingOutstanding: stats[109]?.[11] } };
}
