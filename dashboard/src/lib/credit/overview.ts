import Decimal from 'decimal.js';
import { sumAmounts } from './amounts.ts';
import { creditInstitutionCategory, compareCreditInstitutionTypes } from './presentation.ts';
import { creditItemLabels, creditItemTypes, type CreditInstitutionView } from './types.ts';
import { isCreditEffective } from './validity.ts';

export type CreditChartDatum = { label: string; value: number | null; registeredCount?: number; unregisteredCount?: number; registeredLimit?: number | null; registeredUsed?: number | null; unregisteredUsed?: number | null };
const completeSum = (values: Array<number | null>): number | null => values.some(value => value == null) ? null : sumAmounts(values);
const ratio = (used: number | null, limit: number | null) => used == null || limit == null || limit === 0
  ? null : new Decimal(used).div(limit).times(100).toNumber();

export function buildCreditOverview(institutions: readonly CreditInstitutionView[], reportDate: string) {
  const visible = institutions.filter(row => row.status !== 'revoked');
  const effective = visible.filter(isCreditEffective);
  const categories = [...new Set(visible.map(row => creditInstitutionCategory(row.institutionType)))].sort(compareCreditInstitutionTypes);
  const groups = categories.map(label => ({ label, rows: effective.filter(row => creditInstitutionCategory(row.institutionType) === label) }));
  const bankLimits: CreditChartDatum[] = groups.map(({ label, rows }) => ({ label, value: rows.length ? completeSum(rows.map(row => row.totalLimit)) : null }));
  const bankUsage: CreditChartDatum[] = groups.map(({ label, rows }) => ({ label, value: rows.length ? completeSum(rows.map(row => row.totalUsed)) : null }));
  const bankUtilization: CreditChartDatum[] = groups.map(({ label, rows }) => ({ label, value: ratio(completeSum(rows.map(row => row.totalUsed)), completeSum(rows.map(row => row.totalLimit))) }));
  const products = creditItemTypes.map(type => {
    const items = effective.map(row => row.items.find(item => item.type === type));
    const registered = items.filter(item => item?.limitAmount != null);
    const unregistered = items.filter(item => item?.limitAmount == null);
    const used = (item: typeof items[number]) => item?.usedAmount ?? (type === 'legal_overdraft' || type === 'other' ? 0 : null);
    return { label: creditItemLabels[type],
      limit: registered.length ? sumAmounts(registered.map(item => item!.limitAmount)) : null,
      used: completeSum(items.map(used)),
      registeredCount: registered.length, unregisteredCount: unregistered.length,
      registeredUsed: completeSum(registered.map(used)),
      unregisteredUsed: completeSum(unregistered.map(used)) };
  });
  const productAmounts = products.filter(product => product.label !== creditItemLabels.other).map(product => ({
    label: product.label, registeredCount: product.registeredCount, unregisteredCount: product.unregisteredCount,
    registeredLimit: product.limit, registeredUsed: product.registeredUsed, unregisteredUsed: product.unregisteredUsed,
  }));
  const expiryLabels = ['30日内', '31–90日', '91–180日', '181–365日', '365日以上', '无到期日'];
  const expiryCounts = expiryLabels.map(label => ({ label, value: 0 }));
  for (const row of effective) {
    const days = row.expiryDate ? Math.round((Date.parse(`${row.expiryDate}T00:00:00Z`) - Date.parse(`${reportDate}T00:00:00Z`)) / 86400000) : null;
    const index = days == null ? 5 : days <= 30 ? 0 : days <= 90 ? 1 : days <= 180 ? 2 : days <= 365 ? 3 : 4;
    expiryCounts[index]!.value++;
  }
  return { bankLimits, bankUsage, bankUtilization,
    totalLimit: effective.length ? completeSum(effective.map(row => row.totalLimit)) : null,
    totalUsed: effective.length ? completeSum(effective.map(row => row.totalUsed)) : null,
    utilization: effective.length ? ratio(completeSum(effective.map(row => row.totalUsed)), completeSum(effective.map(row => row.totalLimit))) : null,
    productLimits: productAmounts.map(product => ({ ...product, value: product.registeredLimit })),
    productUsage: products.filter(product => product.label !== creditItemLabels.other).map(product => ({ label: product.label, value: product.used })),
    productUtilization: productAmounts.map(product => ({ ...product, value: ratio(product.registeredUsed, product.registeredLimit) })),
    statusCounts: [{ label: '已获批', value: effective.length }, { label: '申请中', value: visible.filter(row => !isCreditEffective(row)).length }],
    topLimits: [...effective].filter(row => row.totalLimit != null).sort((a, b) => b.totalLimit! - a.totalLimit!).slice(0, 10).map(row => ({ label: row.institutionName, value: row.totalLimit })),
    topUsage: [...effective].filter(row => row.totalUsed != null).sort((a, b) => b.totalUsed! - a.totalUsed!).slice(0, 10).map(row => ({ label: row.institutionName, value: row.totalUsed })),
    topUtilization: [...effective].filter(row => row.utilization != null).sort((a, b) => b.utilization! - a.utilization!).slice(0, 10).map(row => ({ label: row.institutionName, value: row.utilization })),
    expiryCounts };
}
