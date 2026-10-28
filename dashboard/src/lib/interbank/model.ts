export type SourceColumn = '成交编号'|'成交日期'|'本方方向'|'本方'|'对手方'|'本方资金账号'|'对手方资金账号'|'拆借金额(万)'|'拆借利率(%)'|'实际占款天数'|'拆借期限(天)'|'拆借利息'|'到期还款金额'|'首次结算日'|'到期还款日';
export type SourceTrade = Record<SourceColumn, string> & { serialNo: string };
export type ArchiveFile = { source: string; name: string; bytes: Uint8Array; serialNo?: string; digest: string };
export type PreparedBatch = { signature: string; date: string; trades: SourceTrade[]; files: ArchiveFile[]; excel: string };
export type LedgerRow = { id: string | number; serialNo: string; busiDate: string; ourpartyName: string; counterpartyName: string; matchAmount: string | number; matchTime: string; firstSettleDate: string; expireAmount: string | number; financingCode?: string; hid?: string | number | null; allocateReviewStatus?: string | number };
export type Progress = { import?: 'intent' | 'verified'; id?: string | number; draft?: 'intent' | 'verified'; hid?: string | number; attachments?: (string | number)[] };
export type Journal = { signature: string; archived?: boolean; trades: Record<string, Progress>; uploads: Record<string, { digest: string; id?: string | number; status: 'intent' | 'uploaded' }> };
export function sourceRows(values: string[][]): SourceTrade[] {
  const [header, ...body] = values;
  if (!header) throw new Error('Excel 为空');
  const rows = body.filter(row => row.some(v => v !== ''));
  const columns = new Map<string, number[]>();
  header.forEach((name, i) => columns.set(name, [...columns.get(name) ?? [], i]));
  const selected = new Map<string, number>();
  for (const [name, indices] of columns) {
    const filled = indices.filter(i => rows.some(row => !!row[i]));
    if (filled.length > 1 && rows.some(row => new Set(filled.map(i => row[i]).filter(Boolean)).size > 1)) throw new Error(`Excel 重复列冲突：${name}`);
    const complete = filled.filter(i => rows.every(row => !!row[i] || filled.every(j => !row[j])));
    if (filled.length && !complete.length) throw new Error(`Excel 重复列分散填值：${name}`);
    selected.set(name, complete[0] ?? indices[0]!);
  }
  const required = ['成交编号','成交日期','本方方向','本方','对手方','本方资金账号','对手方资金账号','拆借金额(万)','拆借利率(%)','实际占款天数','拆借期限(天)','拆借利息','到期还款金额','首次结算日','到期还款日'] as const;
  for (const name of required) if (!selected.has(name)) throw new Error(`Excel 缺少列：${name}`);
  const seen = new Set<string>();
  return rows.map(row => {
    const value = Object.fromEntries([...selected].map(([name, i]) => [name, row[i] ?? ''])) as SourceTrade;
    value.serialNo = value['成交编号'];
    if (!/^IBO\d{14}$/.test(value.serialNo) || seen.has(value.serialNo)) throw new Error('成交编号无效或重复');
    seen.add(value.serialNo);
    if (value['本方方向'] !== '拆入') throw new Error(`本方方向不是拆入：${value.serialNo}`);
    for (const name of required) if (!value[name]) throw new Error(`Excel 缺少数据：${name} ${value.serialNo}`);
    for (const name of ['成交日期','首次结算日','到期还款日'] as const) {
      value[name] = value[name].slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value[name]) || !Number.isFinite(Date.parse(value[name])) || new Date(value[name]).toISOString().slice(0,10)!==value[name]) throw new Error(`Excel 日期无效：${name}`);
    }
    return value;
  });
}
/** Exact decimal shifting, preserving source precision without recalculating business values. */
export function shiftDecimal(value: string, places: number): string {
  const text = value.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text) || !/[1-9]/.test(text)) throw new Error('Excel 金额或利率无效');
  const [whole = '', fraction = ''] = text.split('.');
  const digits = whole + fraction;
  const point = whole.length + places;
  const output = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point-digits.length) : digits.slice(0,point) + '.' + digits.slice(point);
  return output.replace(/^0+(?=\d)/,'').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
}
export function pdfName(source: string, trade: SourceTrade, text: string): string {
  const bank = text.match(/([^\n]*?银行股份有限公司)/)?.[1]?.trim() || trade['对手方'];
  const short = bank.replaceAll('股份有限公司','').replaceAll('农村商业银行','农').replaceAll('农商银行','农').replaceAll('农商行','农');
  if (!short || /[/\\:*?"<>|\r\n]/.test(short)) throw new Error('PDF 对手方简称无效');
  return `${Number(trade['成交日期'].slice(5).replace('-',''))} ${short} ${shiftDecimal(trade['拆借金额(万)'], -4)}E ${source.split('/').pop()}`;
}
export function correctedRecords(parsed: { status: string; data: Record<string, unknown>[]; totalNum: number; warnings?: unknown[] }, trades: SourceTrade[]) {
  if (parsed.status !== 'SUCCESS' || parsed.warnings?.length || parsed.totalNum !== trades.length || parsed.data.length !== trades.length) throw new Error('资金系统 Excel 解析未通过');
  const source = new Map(trades.map(row => [row.serialNo,row]));
  const seen = new Set();
  const fields: Record<string,SourceColumn> = { counterpartyAccount:'对手方资金账号',ourpartyAccount:'本方资金账号',days:'实际占款天数',daysPurpose:'拆借期限(天)',totalInterest:'拆借利息',expireAmount:'到期还款金额',matchAmount:'拆借金额(万)',ourpartyName:'本方',counterpartyName:'对手方',busiDate:'成交日期',matchTime:'首次结算日',firstSettleDate:'到期还款日' };
  return parsed.data.map(record => {
    const serial = String(record.serialNo), row = source.get(serial);
    if (!row || seen.has(serial)) throw new Error('资金系统成交编号与 Excel 不一致');
    seen.add(serial);
    if (Object.entries(record).some(([key,value]) => /(?:Flg|Flag)$/.test(key) && key !== 'totalInterestRedFlg' && value === true)) throw new Error(`资金系统行校验未通过：${serial}`);
    return { ...record, serialNo:serial, ...Object.fromEntries(Object.entries(fields).map(([key,column]) => [key,row[column]])), interestRate:shiftDecimal(row['拆借利率(%)'],-2),totalInterestRedFlg:false };
  });
}
