// 业务规则，移植自 dashboard/src/lib/interbank/model.ts，两处须保持一致。
export const REQUIRED = ['成交编号', '成交日期', '本方方向', '本方', '对手方', '本方资金账号', '对手方资金账号', '拆借金额(万)', '拆借利率(%)', '实际占款天数', '拆借期限(天)', '拆借利息', '到期还款金额', '首次结算日', '到期还款日'];

export function sourceRows(values) {
  const [header, ...body] = values;
  if (!header) throw new Error('Excel 为空');
  const rows = body.filter(row => row.some(v => v !== ''));
  const columns = new Map();
  header.forEach((name, i) => columns.set(name, [...(columns.get(name) ?? []), i]));
  const selected = new Map();
  for (const [name, indices] of columns) {
    const filled = indices.filter(i => rows.some(row => !!row[i]));
    if (filled.length > 1 && rows.some(row => new Set(filled.map(i => row[i]).filter(Boolean)).size > 1)) throw new Error(`Excel 重复列冲突：${name}`);
    const complete = filled.filter(i => rows.every(row => !!row[i] || filled.every(j => !row[j])));
    if (filled.length && !complete.length) throw new Error(`Excel 重复列分散填值：${name}`);
    selected.set(name, complete[0] ?? indices[0]);
  }
  for (const name of REQUIRED) if (!selected.has(name)) throw new Error(`Excel 缺少列：${name}`);
  const seen = new Set();
  return rows.map(row => {
    const value = Object.fromEntries([...selected].map(([name, i]) => [name, row[i] ?? '']));
    value.serialNo = value['成交编号'];
    if (!/^IBO\d{14}$/.test(value.serialNo) || seen.has(value.serialNo)) throw new Error('成交编号无效或重复');
    seen.add(value.serialNo);
    if (value['本方方向'] !== '拆入') throw new Error(`本方方向不是拆入：${value.serialNo}`);
    for (const name of REQUIRED) if (!value[name]) throw new Error(`Excel 缺少数据：${name} ${value.serialNo}`);
    for (const name of ['成交日期', '首次结算日', '到期还款日']) {
      value[name] = value[name].slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value[name]) || !Number.isFinite(Date.parse(value[name])) || new Date(value[name]).toISOString().slice(0, 10) !== value[name]) throw new Error(`Excel 日期无效：${name}`);
    }
    return value;
  });
}

/** 十进制字符串移位，保留源精度，不做浮点运算。 */
export function shiftDecimal(value, places) {
  const text = value.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) || !/[1-9]/.test(text)) throw new Error('Excel 金额或利率无效');
  const [whole = '', fraction = ''] = text.split('.');
  const digits = whole + fraction;
  const point = whole.length + places;
  const output = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  return output.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function pdfName(source, trade, text) {
  const bank = text.match(/([^\n]*?银行股份有限公司)/)?.[1]?.trim() || trade['对手方'];
  const short = bank.replaceAll('股份有限公司', '').replaceAll('农村商业银行', '农').replaceAll('农商银行', '农').replaceAll('农商行', '农');
  if (!short || /[/\\:*?"<>|\r\n]/.test(short)) throw new Error('PDF 对手方简称无效');
  return `${Number(trade['成交日期'].slice(5).replace('-', ''))} ${short} ${shiftDecimal(trade['拆借金额(万)'], -4)}E ${source.split('/').pop()}`;
}

/** only：只校验并返回这些成交编号（已入库的成交会被解析器标红为重复，不应拖累本次待导入的行）。 */
export function correctedRecords(parsed, trades, only = null) {
  if (parsed.status !== 'SUCCESS' || (Array.isArray(parsed.warnings) ? parsed.warnings.length > 0 : Boolean(parsed.warnings)) || parsed.totalNum !== trades.length || parsed.data.length !== trades.length) throw new Error('资金系统 Excel 解析未通过');
  const source = new Map(trades.map(row => [row.serialNo, row]));
  const seen = new Set();
  const fields = { counterpartyAccount: '对手方资金账号', ourpartyAccount: '本方资金账号', days: '实际占款天数', daysPurpose: '拆借期限(天)', totalInterest: '拆借利息', expireAmount: '到期还款金额', matchAmount: '拆借金额(万)', ourpartyName: '本方', counterpartyName: '对手方', busiDate: '成交日期', matchTime: '首次结算日', firstSettleDate: '到期还款日' };
  return parsed.data.filter(record => {
    const serial = String(record.serialNo);
    if (!source.has(serial) || seen.has(serial)) throw new Error('资金系统成交编号与 Excel 不一致');
    seen.add(serial);
    return !only || only.has(serial);
  }).map(record => {
    const serial = String(record.serialNo), row = source.get(serial);
    if (Object.entries(record).some(([key, value]) => /(?:Flg|Flag)$/.test(key) && key !== 'totalInterestRedFlg' && value === true)) throw new Error(`资金系统行校验未通过：${serial}`);
    return { ...record, serialNo: serial, ...Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column]])), interestRate: shiftDecimal(row['拆借利率(%)'], -2), totalInterestRedFlg: false };
  });
}
