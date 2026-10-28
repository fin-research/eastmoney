import { describe, expect, it } from 'vitest';
import { fetchIssuePricing, pricingDate, pricingInputs } from '../src/sync/quant-pricing.ts';
import { sourceDate } from '../src/sync/quant-input-contract.ts';

describe('issuance pricing facts', () => {
  const bond = { code: '123456.SZ', date: '2026-09-09' };
  it('keeps raw dates and quarantines conflicts without fabricating publication dates', () => {
    const raw = { TENDERDATE: '2026/9/8', TENDERFINALCOUPON: 1.8, ISSCORPCREDITRAT: 'AAA', TENDERANNCDATE: '2026/9/1' };
    const rows = pricingInputs(bond, raw, 'hash');
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.field === 'TENDERDATE')?.textValue).toBe('2026/9/8');
    expect(rows.every(row => row.publishedDate === null && row.dataset === 'issue')).toBe(true);
    expect(pricingInputs(bond, {...raw, TENDERDATE: '2026/9/10'}, 'hash').every(row => row.dataset === 'issue_pricing_quarantine')).toBe(true);
    expect(pricingInputs(bond, {...raw, TENDERDATE: ''}, 'hash')).toHaveLength(3);
    expect(pricingDate('2026/2/30')).toBeNull();
    expect(pricingDate('09:00-18:00')).toBeNull();
    expect(sourceDate('2026/9/8')).toBe('2026-09-08');
    expect(sourceDate('2026/2/30')).toBeNull();
  });
  it('isolates invalid codes and normalizes returned codes', async () => {
    const request = async (_path: string, query: URLSearchParams) => {
      if (query.get('codes')!.includes('BAD')) throw new Error('10003008 invalid stock code');
      return { function: 'CSS', rows: [{code: '123456.sz', TENDERDATE: '2026/9/8', TENDERFINALCOUPON: 1.8}] };
    };
    const result = await fetchIssuePricing(request, [bond, {code: 'BAD.SZ', date: bond.date}]);
    expect(result.invalidCodes).toEqual(['BAD.SZ']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.entityKey).toBe(bond.code);
  });
});
