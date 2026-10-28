import { sumAmounts, subtractAmounts } from './amounts.ts';
import { creditInstitutionCategory } from './presentation.ts';
import type { CreditInstitutionView } from './types.ts';
import { isCreditEffective } from './validity.ts';

const categories = ['政策性银行', '国有银行', '股份制银行', '城、农商行', '其他（外资、境外、民营银行）'];
const aliases: Record<string, string> = {
  '政策性银行': categories[0]!, '国有行': categories[1]!,
  '股份行': categories[2]!, '股份制银行': categories[2]!,
  '城商行': categories[3]!, '农商行': categories[3]!,
  '城市商业银行': categories[3]!, '农村商业银行': categories[3]!,
  '民营银行': categories[4]!, '外资行': categories[4]!, '境外行': categories[4]!,
};
const names = new Intl.Collator('zh-CN', { numeric: true });
const completeSum = (values: Array<number | null>) => values.some(value => value == null) ? null : sumAmounts(values);
function amounts(rows: readonly CreditInstitutionView[]) {
  const totalLimit = completeSum(rows.map(row => row.totalLimit));
  const totalUsed = completeSum(rows.map(row => row.totalUsed));
  return { totalLimit, totalUsed, remaining: totalLimit == null || totalUsed == null ? null : subtractAmounts(totalLimit, totalUsed) };
}

export function buildBankCreditStatus(institutions: readonly CreditInstitutionView[]) {
  const effective = institutions.filter(isCreditEffective);
  const grouped = new Map<string, CreditInstitutionView[]>(categories.map(label => [label, []]));
  for (const row of effective) {
    const category = creditInstitutionCategory(row.institutionType);
    const label = aliases[category] ?? category;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(row);
  }
  return {
    groups: [...grouped].map(([label, rows]) => ({ label, ...amounts(rows) })),
    total: amounts(effective),
    topInstitutions: [...effective].filter(row => row.totalLimit != null)
      .sort((a, b) => b.totalLimit! - a.totalLimit! || names.compare(a.institutionName, b.institutionName))
      .slice(0, 10).map(row => ({ label: row.institutionName, ...amounts([row]) })),
  };
}
