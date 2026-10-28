import { creditItemTypes, type CreditInstitutionView, type CreditItemType, type CreditStatus } from './types.ts';
import type { CreditInstitutionUpdateInput, CreditItemChanges, CreditInstitutionChanges } from './update.ts';
import { subtractAmounts, sumAmounts } from './amounts.ts';

type ItemDraft = { limitAmount: number | null; usedAmount: number | null; secondaryUsedAmount: number | null; details: string };
export type CreditMaintenanceDraft = {
  institutionType: string; status: CreditStatus; confidentialityStatus: boolean; verified: boolean;
  effectiveDate: string; expiryDate: string;
  bankOffice: string; applyingDepartment: string; handler: string;
  detail: string; bondPreference: string; notes: string;
  items: Record<CreditItemType, ItemDraft>;
};

export function creditMaintenanceDraft(row: CreditInstitutionView): CreditMaintenanceDraft {
  return {
    institutionType: row.institutionType, status: row.status, confidentialityStatus: row.confidentialityStatus, verified: row.verified ?? false,
    effectiveDate: row.effectiveDate ?? '', expiryDate: row.expiryDate ?? '',
    bankOffice: row.bankOffice ?? '', applyingDepartment: row.applyingDepartment ?? '', handler: row.handler ?? '',
    detail: row.detail ?? '', bondPreference: row.bondPreference ?? '', notes: row.notes ?? '',
    items: Object.fromEntries(creditItemTypes.map(type => {
      const item = row.items.find(value => value.type === type);
      return [type, { limitAmount: item?.limitAmount ?? null, usedAmount: item?.usedAmount ?? null,
        secondaryUsedAmount: item?.secondaryUsedAmount ?? null, details: item?.details ?? '' }];
    })) as CreditMaintenanceDraft['items'],
  };
}

export function creditMaintenanceAmounts(row: CreditInstitutionView, draft: CreditMaintenanceDraft) {
  const primary = row.items.find(item => item.type === 'bond_investment')?.primaryUsedAmount ?? null;
  const used: Record<CreditItemType, number | null> = {
    bond_investment: primary == null ? null : sumAmounts([primary, draft.items.bond_investment.secondaryUsedAmount]),
    yield_certificate: row.items.find(item => item.type === 'yield_certificate')?.usedAmount ?? null,
    interbank_lending: row.items.find(item => item.type === 'interbank_lending')?.usedAmount ?? null,
    legal_overdraft: draft.items.legal_overdraft.usedAmount,
    other: draft.items.other.usedAmount,
  };
  const remaining = Object.fromEntries(creditItemTypes.map(type => [type,
    type === 'other' || draft.items[type].limitAmount == null || used[type] == null &&
      (type === 'bond_investment' || type === 'yield_certificate' || type === 'interbank_lending')
      ? null : subtractAmounts(draft.items[type].limitAmount!, used[type] ?? 0),
  ])) as Record<CreditItemType, number | null>;
  const totalUsed = row.clients?.length ? sumAmounts(Object.values(used)) : null;
  return { used, remaining, totalUsed, available: row.totalLimit == null || totalUsed == null ? null : subtractAmounts(row.totalLimit, totalUsed) };
}

export function creditMaintenanceChanges(row: CreditInstitutionView, draft: CreditMaintenanceDraft): CreditInstitutionUpdateInput['changes'] {
  const institution: CreditInstitutionChanges = {};
  for (const field of ['institutionType', 'confidentialityStatus', 'effectiveDate', 'expiryDate',
    'bankOffice', 'applyingDepartment', 'handler', 'detail', 'bondPreference', 'notes'] as const) {
    const previous = row[field] ?? '';
    if (draft[field] !== previous) (institution as Record<string, unknown>)[field] = draft[field];
  }
  if (draft.verified !== (row.verified ?? false)) institution.verified = draft.verified;
  if (!draft.expiryDate && row.status !== draft.status) institution.status = draft.status;
  const items: CreditItemChanges[] = [];
  for (const type of creditItemTypes) {
    const before = row.items.find(item => item.type === type);
    const current = draft.items[type];
    const change: CreditItemChanges = { type };
    if (type !== 'other' && current.limitAmount !== (before?.limitAmount ?? null)) change.limitAmount = current.limitAmount;
    if ((type === 'bond_investment' || type === 'other') && current.details !== (before?.details ?? '')) change.details = current.details;
    if (type === 'bond_investment' && current.secondaryUsedAmount !== (before?.secondaryUsedAmount ?? null)) change.secondaryUsedAmount = current.secondaryUsedAmount;
    if ((type === 'legal_overdraft' || type === 'other') && current.usedAmount !== (before?.usedAmount ?? null)) change.usedAmount = current.usedAmount;
    if (Object.keys(change).length > 1) items.push(change);
  }
  return { ...(Object.keys(institution).length ? { institution } : {}), ...(items.length ? { items } : {}) };
}

/** Reverse the bond total into the only manually maintained usage component. */
export function setCreditBondUsage(row: CreditInstitutionView, draft: CreditMaintenanceDraft,
  field: 'used' | 'remaining', value: number | null): void {
  const primary = row.items.find(item => item.type === 'bond_investment')?.primaryUsedAmount;
  const bond = draft.items.bond_investment;
  if (primary == null || field === 'remaining' && bond.limitAmount == null) return;
  bond.secondaryUsedAmount = value == null ? null : sumAmounts(
    field === 'remaining' ? [bond.limitAmount!, -value, -primary] : [value, -primary]);
}
