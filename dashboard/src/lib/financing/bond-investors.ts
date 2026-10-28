export const investorBondTypes = ['公募债', '公募次级债', '私募债', '短融'] as const;
export type InvestorBondType = typeof investorBondTypes[number];
export const investorCategories = ['银行理财', '公募基金', '股份制银行', '券商资管', '国有银行', '城农商行', '券商自营', '保险资管', '其他'] as const;
export type InvestorCategory = typeof investorCategories[number];
export type InvestorAmounts = Record<InvestorBondType, number> & { total: number };
export interface InvestorSummary {
  id: string | null;
  name: string;
  category: InvestorCategory;
  total: InvestorAmounts;
  outstanding: InvestorAmounts;
}
export interface InvestorCategorySummary {
  category: InvestorCategory;
  total: InvestorAmounts;
  outstanding: InvestorAmounts;
}
export const emptyInvestorAmounts = (): InvestorAmounts => ({ 公募债: 0, 公募次级债: 0, 私募债: 0, 短融: 0, total: 0 });

export function investorCategory(type: string | null, subtype: string | null): InvestorCategory {
  if (type === '理财子') return '银行理财';
  if (type === '基金') return '公募基金';
  if (type === '券商') return subtype === '资管' ? '券商资管' : '券商自营';
  if (type === '银行') {
    if (subtype === '国有银行') return '国有银行';
    if (['股份行', '股份制银行'].includes(subtype ?? '')) return '股份制银行';
    if (['城商行', '农商行', '城农商行', '农信联社'].includes(subtype ?? '')) return '城农商行';
  }
  if (subtype === '保险资管') return '保险资管';
  return '其他';
}

export function investorBondType(subtype: string): InvestorBondType | null {
  return ({ 小公募: '公募债', 次级债: '公募次级债', 私募债: '私募债', 短期融资券: '短融' } as Record<string, InvestorBondType>)[subtype] ?? null;
}

export function investorShare(amount: number, total: number): number | null {
  return total > 0 ? amount / total : null;
}

export function validInvestorDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
