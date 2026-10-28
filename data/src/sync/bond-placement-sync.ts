import { z } from 'zod';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import type { DatabaseClient } from './postgres.ts';
import { requireBondBudget } from './bond-history-sync.ts';
import { pricingDate } from './quant-pricing.ts';
import { updateBondPlacement } from './bond-issuance-repository.ts';
import { cssIsolationPoints, syncChoiceCssBatch } from './choice-css-batch.ts';
import { requestCssQuota } from './choice-css-quota.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';
import type { BondRequestFactory } from './issuance-observation-contract.ts';
import type { QuantSyncFailure } from './quant-sync-result.ts';

type Database = <T>(operation: (client: DatabaseClient) => Promise<T>) => Promise<T>;
const response = z.object({ function: z.literal('CSS'), rows: z.array(z.record(z.string(), z.unknown())) });

export async function applyPlacementResponse(db: Database, dates: Record<string, string>, payload: unknown, checkedDate: string) {
  const raw = response.parse(payload);
  const seen = new Set<string>();
  let stored = 0;
  for (const row of raw.rows) {
    const code = String(row.code).toUpperCase();
    if (!dates[code] || seen.has(code)) throw new Error('Unexpected or duplicate placement source code');
    seen.add(code);
    const placement = row.RAISEWAY === '公募' || row.RAISEWAY === '私募' ? row.RAISEWAY : null;
    const maturity = pricingDate(row.MATURITYDATE);
    stored += await db(client => updateBondPlacement(client, code, placement, maturity, checkedDate));
  }
  await db(client => client.query(`UPDATE public.bond_issuance SET placement_checked_at=greatest(placement_checked_at,$2::date)
    WHERE bond_code=ANY($1::text[])`, [Object.keys(dates), checkedDate]));
  return stored;
}

export async function syncBondPlacement(request: DataApiRequest, db: Database, date: string, limit = 200, requestForBonds?: BondRequestFactory) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid placement budget');
  const bonds = await db(client => client.query<{ code: string; date: string }>(`SELECT bond_code AS code,issue_date::text AS date
    FROM public.bond_issuance WHERE placement_type IS NULL AND bond_code ~ '\\.(SH|SZ)$'
      AND issue_date >= $1::date-90 AND issue_date <= $1::date
      AND placement_checked_at IS NULL AND placement_invalid_code=false
    ORDER BY placement_checked_at NULLS FIRST,issue_date DESC,bond_code LIMIT $2`, [date, limit]));
  if (bonds.rows.length) {
    requireBondBudget(await requestCssQuota(request), date, cssIsolationPoints(bonds.rows.length, 2, 100));
  }
  let stored = 0;
  const failures: QuantSyncFailure[] = [];
  for (let offset = 0; offset < bonds.rows.length; offset += 100) {
    const batch = bonds.rows.slice(offset, offset + 100);
    const codes = batch.map(row => row.code);
    try {
      await syncChoiceCssBatch(requestForBonds?.(batch) ?? request, codes, ['RAISEWAY', 'MATURITYDATE'], 'Ispandas=1', async (valid, raw) => {
        const dates = Object.fromEntries(batch.filter(row => valid.includes(row.code)).map(row => [row.code, row.date]));
        stored += await applyPlacementResponse(db, dates, raw, date);
      }, async code => {
        await db(client => client.query('UPDATE public.bond_issuance SET placement_invalid_code=true WHERE bond_code=$1', [code]));
      });
    } catch (error) {
      // Permission, quota and transport failures stop paid work; completed leaves remain stored.
      failures.push({ source: 'bond-placement', error: economicIndicatorErrorDetails(error).message });
      break;
    }
  }
  const missing = await db(client => client.query<{ code: string; date: string; invalid: boolean }>(`SELECT bond_code AS code,
    issue_date::text AS date,placement_invalid_code AS invalid FROM public.bond_issuance
    WHERE placement_type IS NULL AND bond_code ~ '\\.(SH|SZ)$'`));
  if (missing.rows.length) failures.push({ source: 'bond-placement', error: 'Unverified offering classifications remain', kind: 'data_gap' });
  const firstDailyDate = new Date(Date.parse(`${date}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
  return { stored, failures,
    missing: missing.rows.map(row => ({ source: 'bond-placement', codes: [row.code], dates: [row.date], fields: ['RAISEWAY'],
      reason: row.invalid ? 'invalid_code' : row.date < firstDailyDate ? 'outside_daily_window' : 'not_returned' })) };
}
