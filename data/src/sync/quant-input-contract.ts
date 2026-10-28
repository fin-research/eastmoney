// Source fields used by quant. Keep Choice IDs separate from logical field names.
export const FUNDING_FIELDS = ['dr007', 'r007', 'shibor3m', 'omo7d', 'cgb1y', 'cgb3y', 'cgb10y', 'cdb3y', 'cdb10y', 'aaa3y'] as const;
export const FUNDING_EDB: Record<string, string> = {
  dr007: 'E1300004', r007: 'E1704420', omo7d: 'E1715081',
  cgb1y: 'E1000172', cgb3y: 'E1000174', cgb10y: 'E1000180',
  shibor3m: 'E1300079', cdb3y: 'E1701708', cdb10y: 'E1701714', aaa3y: 'E1000413',
};
export const EQUITY_CODES = ['000001.SH','399001.SZ','000300.SH','000852.SH','399006.SZ','000688.SH','800004.EI','VIX.GI'];
export const EQUITY_FIELDS = ['sse_close','szse_close','csi300_close','csi1000_close','chinext_close','star50_close','all_a_close','vix_close'];
export const VALUATION_FIELDS: Record<string, string> = {
  MV: 'all_a_market_cap', PETTM: 'all_a_pe_ttm', AMOUNT: 'all_a_turnover_amount',
  TURN: 'all_a_turnover_rate', ERPMINUSM: 'equity_bond_spread',
};
export const SECONDARY_FIELDS = [
  'TOTAL_VOLUME','INTEREST_BOND_VOLUME','INTEREST_BOND_RATIO','NCD_VOLUME','NCD_RATIO',
  'FINANCIAL_BOND_VOLUME','FINANCIAL_BOND_RATIO','CORPORATE_BOND_VOLUME','CORPORATE_BOND_RATIO',
  'ABS_VOLUME','ABS_RATIO','AGENCY_BOND_VOLUME','AGENCY_BOND_RATIO','INTL_AGENCY_BOND_VOLUME',
  'INTL_AGENCY_BOND_RATIO','FOREIGN_BOND_VOLUME','FOREIGN_BOND_RATIO',
];
export const ISSUE_FIELDS = [
  'SECUCODE','BOND_NAME_ABBR','BOND_TYPE','ISSUE_DATE','ACTUAL_ISSUE_SCALE',
  'BOND_EXPIRE_YEAR','ISSUERATE_REFERENCE','PAYPERYEAR','TOMRTY_YEAR','DEC_TOMRTYYEAR1',
  'ISSUER_RATING','BOND_RATING','IS_OEB','IS_GUARANTEE','PI_RATE_TYPE','ISSUER_NAME','ORGFORM',
];
export const ISSUE_PRICING_FIELDS = ['TENDERDATE', 'TENDERFINALCOUPON', 'ISSCORPCREDITRAT', 'TENDERANNCDATE'] as const;
export const ISSUE_STAT_FIELDS = [
  'ISSUE_AMT','ISSUE_NUM','TOTAL_REPAY_AMT','TOTAL_REPAY_NUM','NET_FINANCE_AMT',
  'END_REPAY_AMT','END_REPAY_NUM','ADVANCED_REPAY_AMT','ADVANCED_REPAY_NUM',
  'RESALE_AMT','RESALE_NUM','REDEEM_AMT','REDEEM_NUM','VIOLATE_AMT','VIOLATE_NUM','WEIGHTED_COST',
];

export type QuantInput = {
  dataset: string; entityKey: string; field: string; observationDate: string;
  numericValue: number | null; textValue: string | null; publishedDate: string | null;
  source: string; sourceKey: string; sourceHash: string;
};

export function sourceDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10).replaceAll('/', '-');
  const shortDate = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const normalized = /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`
    : shortDate ? `${shortDate[1]}-${shortDate[2]!.padStart(2,'0')}-${shortDate[3]!.padStart(2,'0')}` : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const time = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0,10) === normalized ? normalized : null;
}

export function pricingDate(value: unknown): string | null {
  const raw = String(value ?? '');
  return /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.test(raw) ? sourceDate(raw) : null;
}

export function inputValue(
  dataset: string, field: string, observationDate: string, value: unknown,
  source: string, sourceKey: string, sourceHash: string, entityKey = '',
  publishedDate: string | null = null,
): QuantInput | null {
  if (value === null || value === undefined || value === '' || value === '--' || value === '—') return null;
  if (!sourceDate(observationDate)) throw new Error('Invalid input observation date');
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  if (numeric !== null && !Number.isFinite(numeric)) return null;
  if (numeric === null && typeof value !== 'string') throw new Error(`Invalid input field ${dataset}.${field}`);
  return {dataset, entityKey, field, observationDate, numericValue: numeric,
    textValue: numeric === null ? String(value) : null, publishedDate, source, sourceKey, sourceHash};
}
