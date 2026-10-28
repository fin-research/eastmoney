import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { ISSUE_PRICING_FIELDS, inputValue, pricingDate, type QuantInput } from './quant-input-contract.ts';
import { markPricingInvalidCode, updateBondPricing } from './bond-issuance-repository.ts';
import type { DatabaseClient } from './postgres.ts';
import type { BondRequestFactory } from './issuance-observation-contract.ts';

const table = z.object({ function: z.literal('CSS'), rows: z.array(z.record(z.string(), z.unknown())) });
type Bond = { code: string; date: string };
export { pricingDate } from './quant-input-contract.ts';

export function pricingInputs(bond: Bond, raw: Record<string, unknown>, hash: string, source = 'choice-api', key = 'issue-pricing'): QuantInput[] {
  const date = pricingDate(raw.TENDERDATE);
  const quarantine = raw.TENDERDATE != null && raw.TENDERDATE !== '' && (!date || date > bond.date);
  return ISSUE_PRICING_FIELDS.flatMap(field => {
    const value = inputValue(quarantine ? 'issue_pricing_quarantine' : 'issue', field, bond.date,
      raw[field], source, key, hash, bond.code.toUpperCase());
    return value ? [value] : [];
  });
}

export async function fetchIssuePricing(request: DataApiRequest, bonds: Bond[]): Promise<{ rows: QuantInput[]; invalidCodes: string[] }> {
  if (!bonds.length) return { rows: [], invalidCodes: [] };
  let payload: z.infer<typeof table>;
  try {
    payload = table.parse(await request('/choice/css', new URLSearchParams({
      codes: bonds.map(bond => bond.code).join(','), indicators: ISSUE_PRICING_FIELDS.join(','), options: 'Ispandas=1',
    })));
  } catch (error) {
    if (!/10003008|invalid stock code/i.test(String(error))) throw error;
    if (bonds.length === 1) return { rows: [], invalidCodes: [bonds[0]!.code] };
    const middle = Math.ceil(bonds.length / 2);
    const a = await fetchIssuePricing(request, bonds.slice(0, middle));
    const b = await fetchIssuePricing(request, bonds.slice(middle));
    return { rows: [...a.rows, ...b.rows], invalidCodes: [...a.invalidCodes, ...b.invalidCodes] };
  }
  const byCode = new Map(bonds.map(bond => [bond.code.toUpperCase(), bond]));
  const hash = createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex');
  const rows = payload.rows.flatMap(raw => {
    const bond = byCode.get(String(raw.code).toUpperCase());
    if (!bond) throw new Error('Unexpected pricing code');
    return pricingInputs(bond, raw, hash);
  });
  return { rows, invalidCodes: [] };
}

export async function syncIssuePricing(
  request: DataApiRequest, db: <T>(operation: (client: DatabaseClient) => Promise<T>) => Promise<T>, endDate: string,
  requestForBonds?: BondRequestFactory,
) {
  const bonds = await db(async client => (await client.query<Bond>(`SELECT bond_code AS code,issue_date::text AS date
    FROM public.bond_issuance WHERE bond_code ~ '\\.(SH|SZ)$'
      AND issue_date BETWEEN $1::date-90 AND $1::date
      AND (tender_date IS NULL OR final_coupon_pct IS NULL OR issuance_rating IS NULL OR tender_announcement_date IS NULL)
      AND quarantine_tender_date IS NULL AND pricing_invalid_code=false
    ORDER BY issue_date DESC,bond_code LIMIT 64`, [endDate])).rows);
  if (!bonds.length) return { stored: 0, failures: [], missing: [] };
  const { rows, invalidCodes } = await fetchIssuePricing(requestForBonds?.(bonds) ?? request, bonds);
  const missing = bonds.flatMap(bond => {
    const fields = ISSUE_PRICING_FIELDS.filter(field => !rows.some(row => row.dataset === 'issue' && row.entityKey === bond.code && row.field === field));
    return fields.length ? [{ source: 'issue-pricing', codes: [bond.code], dates: [bond.date], fields }] : [];
  });
  const stored = await db(client => persistPricingRows(client, bonds, rows, invalidCodes));
  return { stored, missing, failures: missing.length ? [{ source: 'issue-pricing', error: 'Pricing metadata incomplete', kind: 'data_gap' as const }] : [] };
}

export async function persistPricingRows(client: DatabaseClient, bonds: Bond[], rows: QuantInput[], invalidCodes: string[] = []) {
  let count = 0;
  for (const bond of bonds) {
    const values = rows.filter(row => row.entityKey === bond.code);
    if (invalidCodes.includes(bond.code)) {
      await markPricingInvalidCode(client, bond.code);
      continue;
    }
    if (!values.length) continue;
    const fields = Object.fromEntries(values.map(row => [row.field, row.numericValue ?? row.textValue]));
    const quarantined = values.some(row => row.dataset === 'issue_pricing_quarantine');
    count += await updateBondPricing(client, bond.code, fields, quarantined);
  }
  return count;
}
