import { creditItemTypes, type ParsedCreditInstitution } from './types.ts';
import type { CreditInstitutionUpdateInput } from './update.ts';

export const institutionEntryFields = {
  verified: 'verified', institutionType: 'institution_type', confidentialityStatus: 'confidentiality_status', status: 'status',
  totalLimit: 'total', effectiveDate: 'effective_date', expiryDate: 'expiry_date',
  bankOffice: 'bank_office', applyingDepartment: 'applying_department', handler: 'handler',
  detail: 'detail', bondPreference: 'bond_preference', notes: 'notes',
} as const;

export function toCreditEntryPatch(changes: CreditInstitutionUpdateInput['changes']): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes.institution ?? {})) {
    const column = institutionEntryFields[key as keyof typeof institutionEntryFields];
    if (column) patch[column] = value;
  }
  for (const item of changes.items ?? []) {
    if (item.type !== 'other' && 'limitAmount' in item) patch[`${item.type}_limit`] = item.limitAmount;
    if ((item.type === 'bond_investment' || item.type === 'other') && 'details' in item) patch[`${item.type}_detail`] = item.details;
    if (item.type === 'bond_investment' && 'secondaryUsedAmount' in item) patch.bond_investment_secondary_used = item.secondaryUsedAmount;
    if ('usedAmount' in item && item.type !== 'bond_investment' && item.type !== 'yield_certificate' && item.type !== 'interbank_lending') {
      patch[`${item.type}_used`] = item.usedAmount;
    }
  }
  return patch;
}

export function toCreditImportPatch(institution: ParsedCreditInstitution): Record<string, unknown> {
  return { ...toCreditEntryPatch({
    institution: Object.fromEntries(Object.keys(institutionEntryFields).filter(key => key !== 'verified').map(key =>
      [key, institution[key as keyof ParsedCreditInstitution] ?? null])),
    items: creditItemTypes.map(type => {
      const item = institution.items.find(item => item.type === type);
      return { type, ...(type === 'other' ? {} : { limitAmount: item?.limitAmount ?? null }),
        ...((type === 'bond_investment' || type === 'other') ? { details: item?.details ?? null } : {}),
        ...(type === 'yield_certificate' || type === 'interbank_lending' ? {} : { usedAmount: item?.usedAmount ?? null }) };
    }),
  }), ...(institution.status==='revoked' ? {expiry_date:'1970-01-01'} : {}), bond_investment_used: institution.items.find(item => item.type === 'bond_investment')?.usedAmount ?? null };
}
