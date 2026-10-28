import type { CreditInstitutionView, CreditStatus } from './types.ts';

export type CreditEffectiveStatus = CreditStatus;
type CreditPeriod = Pick<CreditInstitutionView, 'status' | 'expiryDate' | 'reportDate'>;
export const revokedCreditExpiry = '1970-01-01';

/** Undated institutions retain their recorded status; dated ones use the view date. */
export function creditEffectiveStatus(institution: CreditPeriod): CreditEffectiveStatus {
  if (institution.expiryDate === revokedCreditExpiry) return 'revoked';
  if (!institution.expiryDate) return institution.status;
  return institution.reportDate <= institution.expiryDate ? 'approved' : 'applying';
}

export function isCreditEffective(institution: CreditPeriod): boolean {
  return creditEffectiveStatus(institution) === 'approved';
}
