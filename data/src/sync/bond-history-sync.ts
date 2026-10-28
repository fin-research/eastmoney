import { CssResponseArchiveError } from './css-response-evidence.ts';
import { z } from 'zod';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import type { DatabaseClient } from './postgres.ts';
import { encodeExchangeBondCode } from './exchange-bond-code.ts';
import { cssIsolationPoints, isChoiceError, syncChoiceCssBatch } from './choice-css-batch.ts';
import { requestCssQuota } from './choice-css-quota.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';
import type { QuantSyncFailure } from './quant-sync-result.ts';

const table = z.object({ function: z.string(), rows: z.array(z.record(z.string(), z.unknown())) });
const indicators = ['YIELDCNBD', 'BONDBALANCE', 'MATUCNBD'];
type Database = <T>(operation: (client: DatabaseClient) => Promise<T>) => Promise<T>;
type Gap = { date: string; code: string; canonical_code?: string };
type Incomplete = Gap & { missing_fields: string[]; conflict_fields: string[] };
type Observation = { code: string; yield: number | null; balance: number | null; term: number | null };

export function bondObservations(raw: unknown, codes: string[]): Observation[] {
  const payload = table.parse(raw);
  if (payload.function !== 'CSS') throw new Error('Unexpected bond history source');
  const seen = new Set<string>();
  const number = (value: unknown) => value == null || value === '' ? null : Number(value);
  return payload.rows.map(row => {
    const code = String(row.code ?? '').toUpperCase();
    if (!codes.includes(code) || seen.has(code)) throw new Error('Unexpected or duplicate bond code');
    seen.add(code);
    const values = indicators.map(key => number(row[key]));
    if (values.some(value => value !== null && !Number.isFinite(value)) ||
      values.slice(1).some(value => value !== null && value < 0)) throw new Error('Invalid bond observation');
    return { code, yield: values[0]!, balance: values[1]!, term: values[2]! };
  });
}

export function requireBondBudget(raw: unknown, date: string, points: number) {
  const payload = table.parse(raw);
  const quota = payload.rows.find(row => row.FUNCENAME === 'EM_CSS' && row.SECUTYPE === '全品种');
  const remaining = Number(quota?.AVAILABEDATA);
  if (payload.function !== 'DATASTATISTICS' || quota?.PERIOD !== 'W' ||
    String(quota.STARTDATE ?? '') > date || String(quota.ENDDATE ?? '') < date ||
    quota.AVAILABEDATA == null || !Number.isFinite(remaining) || remaining < points + 100_000) {
    throw new Error('Bond CSS quota unavailable or below shared reserve');
  }
}

const gapsSql = `WITH dates AS (SELECT unnest($1::date[]) AS observation_date),
  known AS MATERIALIZED (SELECT * FROM public.bond_history_observations($1::date[])), candidates AS (
  SELECT d.observation_date::text AS date,i.bond_code AS code,ci.bond_code AS canonical_code
  FROM dates d JOIN public.bond_issuance i ON i.issue_date<=d.observation_date
  LEFT JOIN public.bond_history_identity m ON m.source_code=i.bond_code AND d.observation_date>=m.effective_from
  JOIN public.bond_issuance ci ON ci.bond_code=coalesce(m.canonical_code,i.bond_code)
  LEFT JOIN LATERAL (SELECT outstanding_balance_cny FROM public.bond_history h
    WHERE h.bond_code=public.exchange_bond_code(ci.bond_code) AND h.valuation_date<d.observation_date
    ORDER BY h.valuation_date DESC LIMIT 1) prev ON true
  WHERE public.exchange_bond_code(i.bond_code) IS NOT NULL AND i.history_invalid_code=false AND ci.history_invalid_code=false
    AND i.actual_issuance_status<>'not_issued' AND ci.actual_issuance_status<>'not_issued'
    AND ($3::text[] IS NULL OR i.bond_code=ANY($3::text[]))
    AND ($4::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) a(date date,code text)
      WHERE a.date=d.observation_date AND a.code=i.bond_code))
    AND coalesce(prev.outstanding_balance_cny,1)>0
    AND (i.maturity_date IS NULL OR i.maturity_date>=d.observation_date)
    AND NOT EXISTS (SELECT 1 FROM known h
      WHERE h.bond_code=public.exchange_bond_code(ci.bond_code) AND h.valuation_date=d.observation_date
        AND ($2::boolean OR public.exchange_bond_code(ci.bond_code)=ANY(h.raw_codes)))
  ) SELECT DISTINCT ON (date,CASE WHEN $2::boolean THEN code ELSE canonical_code END) date,code,canonical_code
  FROM candidates ORDER BY date DESC,CASE WHEN $2::boolean THEN code ELSE canonical_code END,code LIMIT 6000`;
const excludedSql = `WITH known AS MATERIALIZED (SELECT * FROM public.bond_history_observations($1::date[]))
  SELECT DISTINCT d.observation_date::text AS date,i.bond_code AS code,ci.bond_code AS canonical_code
  FROM (SELECT unnest($1::date[]) AS observation_date) d JOIN public.bond_issuance i ON i.issue_date<=d.observation_date
  LEFT JOIN public.bond_history_identity m ON m.source_code=i.bond_code AND d.observation_date>=m.effective_from
  JOIN public.bond_issuance ci ON ci.bond_code=coalesce(m.canonical_code,i.bond_code)
  LEFT JOIN LATERAL (SELECT outstanding_balance_cny FROM public.bond_history h
    WHERE h.bond_code=public.exchange_bond_code(ci.bond_code) AND h.valuation_date<d.observation_date
    ORDER BY h.valuation_date DESC LIMIT 1) prev ON true
  WHERE i.actual_issuance_status<>'not_issued' AND ci.actual_issuance_status<>'not_issued'
    AND (i.history_invalid_code=true OR ci.history_invalid_code=true) AND public.exchange_bond_code(i.bond_code) IS NOT NULL
    AND coalesce(prev.outstanding_balance_cny,1)>0
    AND (i.maturity_date IS NULL OR i.maturity_date>=d.observation_date)
    AND NOT EXISTS (SELECT 1 FROM known h
      WHERE h.bond_code=public.exchange_bond_code(ci.bond_code) AND h.valuation_date=d.observation_date
        AND public.exchange_bond_code(ci.bond_code)=ANY(h.raw_codes))
  ORDER BY date DESC,code LIMIT 6000`;
const notIssuedSql = `SELECT d.observation_date::text AS date,i.bond_code AS code
  FROM (SELECT unnest($1::date[]) AS observation_date) d
  JOIN public.bond_issuance i ON i.issue_date<=d.observation_date
  WHERE i.actual_issuance_status='not_issued' AND public.exchange_bond_code(i.bond_code) IS NOT NULL
  ORDER BY date DESC,code LIMIT 6000`;
const incompleteSql = `SELECT h.valuation_date::text AS date,i.bond_code AS code,
    array_remove(ARRAY[
      CASE WHEN h.chinabond_yield_pct IS NULL THEN 'YIELDCNBD' END,
      CASE WHEN h.outstanding_balance_cny IS NULL THEN 'BONDBALANCE' END,
      CASE WHEN h.remaining_term_years IS NULL THEN 'MATUCNBD' END],NULL) AS missing_fields,h.conflict_fields
  FROM public.bond_history_observations($1::date[]) h JOIN public.bond_issuance i
    ON h.bond_code=public.exchange_bond_code(i.bond_code)
  WHERE i.actual_issuance_status<>'not_issued' AND h.valuation_date=ANY($1::date[])
    AND (i.maturity_date IS NULL OR i.maturity_date>=h.valuation_date)
    AND (h.outstanding_balance_cny IS NULL OR h.outstanding_balance_cny>0 OR cardinality(h.conflict_fields)>0)
    AND (h.chinabond_yield_pct IS NULL OR h.outstanding_balance_cny IS NULL
      OR h.remaining_term_years IS NULL)
  ORDER BY date DESC,code LIMIT 6000`;

export async function syncBondHistory(request: DataApiRequest, db: Database, endDate: string, dates: string[], quotaDate = endDate, allowedCodes?: readonly string[], allowedPairs?: readonly Gap[]) {
  const first = new Date(Date.parse(`${endDate}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  if (!dates.length || new Set(dates).size !== dates.length || dates.some(date =>
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first || date >= endDate ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    throw new Error('Bond history trading calendar unavailable or outside completed window');
  }
  const discovered = await db(client => client.query<Gap>(gapsSql,
    [dates,Boolean(allowedCodes || allowedPairs),allowedCodes ?? null,allowedPairs ? JSON.stringify(allowedPairs) : null]));
  const allowedKeys = allowedPairs && new Set(allowedPairs.map(pair => `${pair.date}/${pair.code}`));
  const eligible = discovered.rows.filter(row => (!allowedCodes || allowedCodes.includes(row.code))
    && (!allowedKeys || allowedKeys.has(`${row.date}/${row.code}`)));
  // Frozen recoveries keep their actual authorized source codes. A new daily
  // plan requests each evidenced canonical security once; intents bind those codes.
  const gaps = { rows: [...new Map(eligible.map(row => {
    const pair = { date: row.date, code: allowedCodes || allowedPairs ? row.code : row.canonical_code ?? row.code };
    return [`${pair.date}/${pair.code}`, pair] as const;
  })).values()] };
  let stored = 0;
  const failures: QuantSyncFailure[] = [];
  const invalidCodes = new Set<string>();
  let previousServiceFailure = false;
  const missingDates = [...new Set(gaps.rows.map(row => row.date))];
  let quotaAvailable = true;
  if (gaps.rows.length) {
    const points = missingDates.reduce((sum, date) => sum + cssIsolationPoints(
      gaps.rows.filter(row => row.date === date).length, indicators.length, 200), 0);
    try { requireBondBudget(await requestCssQuota(request), quotaDate, points); }
    catch (error) {
      quotaAvailable = false;
      failures.push({ source: 'bond-history', error: economicIndicatorErrorDetails(error).message, kind: 'execution' });
    }
  }
  paid: for (const date of quotaAvailable ? missingDates : []) {
    const allCodes = gaps.rows.filter(row => row.date === date && !invalidCodes.has(row.code)).map(row => row.code);
    for (let offset = 0; offset < allCodes.length; offset += 200) {
      const codes = allCodes.slice(offset, offset + 200);
      try {
        await syncChoiceCssBatch(request, codes, indicators, `EndDate=${date},CredType=1`, async (valid, raw) => {
          const rows = bondObservations(raw, valid).filter(row =>
            row.yield != null || row.balance != null || row.term != null)
            .map(row => ({ ...row, code: encodeExchangeBondCode(row.code) }));
          if (!rows.length) return;
          const result = await db(client => client.query(`INSERT INTO public.bond_history
          (bond_code,valuation_date,chinabond_yield_pct,outstanding_balance_cny,remaining_term_years)
        SELECT code,$1::date,yield,balance,term FROM jsonb_to_recordset($2::jsonb)
          x(code integer,yield double precision,balance double precision,term double precision)
        ON CONFLICT (bond_code,valuation_date) DO NOTHING`,
          [date, JSON.stringify(rows)]));
          stored += result.rowCount ?? 0;
        }, async code => {
          await db(client => client.query('UPDATE public.bond_issuance SET history_invalid_code=true WHERE bond_code=$1', [code]));
          invalidCodes.add(code);
        });
        previousServiceFailure = false;
      } catch (error) {
        failures.push({ source: 'bond-history', error: JSON.stringify({ date, codes,
          error: economicIndicatorErrorDetails(error).message }), ...(error instanceof CssResponseArchiveError ? { kind: 'execution' as const } : {}) });
        // One failed batch must not hide independent dates. Consecutive service
        // failures indicate a wider outage; unknown/permission/quota errors stop.
        if (!isChoiceError(error, 10000013) || previousServiceFailure) break paid;
        previousServiceFailure = true;
      }
    }
  }
  async function coverage<T extends Gap>(sql: string, phase: string) {
    try { return (await db(client => client.query<T>(sql, sql === gapsSql ? [dates,false,null,null] : [dates]))).rows; }
    catch (error) {
      failures.push({ source: 'bond-history-coverage', error: `${phase}: ${economicIndicatorErrorDetails(error).message}`, kind: 'execution' });
      return [] as T[];
    }
  }
  const absent = await coverage<Gap>(gapsSql, 'absent');
  const incomplete = await coverage<Incomplete>(incompleteSql, 'incomplete');
  const excluded = await coverage<Gap>(excludedSql, 'excluded');
  const notIssued = await coverage<Gap>(notIssuedSql, 'not_issued');
  const missing = new Map<string, { source: string; dates: string[]; codes: string[]; fields: string[]; reason: string }>();
  for (const [rows, reason] of [[absent, 'observation_absent'], [incomplete, 'stored_fields_incomplete'],
    [excluded, 'invalid_code']] as const) {
    for (const row of rows) {
      const code = row.canonical_code ?? row.code;
      missing.set(`${row.date}/${code}`, { source: 'bond-history', dates: [row.date], codes: [code],
        fields: 'missing_fields' in row ? row.missing_fields : indicators,
        reason: 'conflict_fields' in row && row.conflict_fields.length ? 'source_value_conflict' : reason });
    }
  }
  if (missing.size) failures.push({ source: 'bond-history', error: 'Unresolved bond observations', kind: 'data_gap' });
  if (excluded.length) failures.push({ source: 'bond-history', error: `${new Set(excluded.map(row => row.code)).size} invalid codes excluded from automatic retries`, kind: 'data_gap' });
  return { stored, failures, missing: [...missing.values()], notApplicable: notIssued.map(row => ({...row, reason:'not_issued' as const})) };
}
