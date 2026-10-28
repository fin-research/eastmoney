import type { CreditInstitutionView } from './types.ts';

const quarterEnds = ['03-31', '06-30', '09-30', '12-31'];

export function isCreditFinalized(row: Pick<CreditInstitutionView, 'verified'>, reportDate: string): boolean {
  return quarterEnds.includes(reportDate.slice(5)) && row.verified === true;
}

export function creditQuarterDates(year: number, minDate?: string) {
  return quarterEnds.map((end, index) => ({
    date: `${year}-${end}`, label: `${String(year).slice(-2)}Q${index + 1}`,
  })).filter(option => !minDate || option.date >= minDate);
}
