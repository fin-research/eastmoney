import type { CreditInstitutionView } from './types.ts';
import { creditInstitutionCategory, compareCreditInstitutionTypes } from './presentation.ts';

export type CreditSortKey = 'institutionName' | 'institutionType' | 'status' | 'totalLimit' | 'totalUsed' | 'availableAmount' | 'utilization' | 'effectiveDate' | 'expiryDate';
export type CreditSort = { key: CreditSortKey; direction: 'ascending' | 'descending' };
export const defaultCreditSort: readonly CreditSort[] = [
  { key: 'institutionType', direction: 'ascending' },
  { key: 'totalLimit', direction: 'descending' },
];
const collator = new Intl.Collator('zh-CN', { numeric: true });
const statusLabels = { approved: '已获批', applying: '申请中', revoked: '已撤销' };

export function cycleCreditSort(sorts: readonly CreditSort[], key: CreditSortKey): CreditSort[] {
  const current = sorts.find(sort => sort.key === key);
  if (!current) return [...sorts, { key, direction: 'ascending' }];
  if (current.direction === 'descending') return sorts.filter(sort => sort.key !== key);
  return sorts.map(sort => sort.key === key ? { key, direction: 'descending' } : sort);
}

export function compareCreditInstitutions(left: CreditInstitutionView, right: CreditInstitutionView, sorts: readonly CreditSort[]): number {
  for (const { key, direction } of sorts) {
    const a = key === 'status' ? statusLabels[left.status] : left[key];
    const b = key === 'status' ? statusLabels[right.status] : right[key];
    if (a == null && b == null) continue;
    if (a == null) return 1;
    if (b == null) return -1;
    const result = key === 'institutionType'
      ? compareCreditInstitutionTypes(String(a), String(b))
      : typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
    if (result) return direction === 'ascending' ? result : -result;
  }
  return collator.compare(left.institutionName, right.institutionName);
}

/** A category remains one row group; other selected keys sort its institutions. */
export function groupCreditInstitutions(rows: readonly CreditInstitutionView[], sorts: readonly CreditSort[]) {
  const groups = new Map<string, CreditInstitutionView[]>();
  for (const row of rows) {
    const label = creditInstitutionCategory(row.institutionType);
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  const direction = sorts.find(sort => sort.key === 'institutionType')?.direction === 'descending' ? -1 : 1;
  return [...groups].sort(([a], [b]) => direction * compareCreditInstitutionTypes(a, b))
    .map(([institutionType, institutions]) => ({ institutionType,
      institutions: institutions.sort((a, b) => compareCreditInstitutions(a, b, sorts.filter(sort => sort.key !== 'institutionType'))) }));
}
