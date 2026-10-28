import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { EQUITY_CODES, EQUITY_FIELDS, VALUATION_FIELDS, inputValue, type QuantInput } from './quant-input-contract.ts';
import { persistQuantInputs } from './quant-input-repository.ts';
import { withPostgres } from './postgres.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';
import { fetchChoiceTable } from '../choice/client.ts';
import { requestCssQuota } from './choice-css-quota.ts';

type ChoiceEnv = Pick<Cloudflare.Env, 'CHOICE_RPC' | 'CHOICE_RPC_TOKEN' | 'CHOICE_FAST_LIMIT' | 'CHOICE_OTHER_LIMIT'>;
type Env = ChoiceEnv & Pick<Cloudflare.Env, 'HYPERDRIVE'>;
type CssSpec = { id: string; date: string; codes: string[]; indicators: string[]; options: string; targets: string[] };
type FetchResult = { spec: CssSpec; rows: QuantInput[]; detail: string; status: 'complete' | 'partial' | 'failed' };
const tableSchema = z.object({ function: z.string(), rows: z.array(z.record(z.string(), z.unknown())) });
// Daily issuance/pricing also uses CSS. Keep a larger shared cushion than this group's 104-point maximum.
const CSS_QUOTA_RESERVE = 100_000;

function priorDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}

export async function tradingDates(env: ChoiceEnv, startDate: string, endDate: string, market: string): Promise<string[]> {
  if (endDate < startDate) return [];
  const table = await fetchChoiceTable(env, 'tradedates', {
    startDate, endDate, options: `Market=${market},Period=1,Order=1`,
  });
  if (table.function !== 'TRADEDATES') throw new Error(`Unexpected ${market} trading calendar`);
  return [...new Set(table.rows.map(row => row.date).filter((date): date is string =>
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= startDate && date <= endDate))].sort();
}

function requiredFields(spec: CssSpec): string[] { return spec.targets; }

export async function syncQuantEquityCss(env: Env, request: DataApiRequest, startDate: string, endDate: string) {
  const db = <T>(operation: Parameters<typeof withPostgres<T>>[2]) =>
    withPostgres(env.HYPERDRIVE.connectionString, 'quant-input-sync', operation);
  const coverage = await db(async client => {
    const result = await client.query<{ date: string; fields: string[] }>(`SELECT observation_date::text AS date,
        array_agg(DISTINCT field ORDER BY field) AS fields
      FROM public.quant_input WHERE observation_date BETWEEN $1::date AND $2::date
        AND field = ANY($3::text[])
      GROUP BY observation_date`, [startDate, endDate, [...EQUITY_FIELDS, ...Object.values(VALUATION_FIELDS)]]);
    return new Map(result.rows.map(row => [row.date, new Set(row.fields)]));
  });
  // At Shanghai midnight China's preceding day is closed; the US preceding day is still trading.
  const [chinaDates, usDates] = await Promise.all([
    tradingDates(env, startDate, priorDate(endDate, 1), 'CNSESH'),
    tradingDates(env, startDate, priorDate(endDate, 2), 'USSE00'),
  ]);
  const specs: CssSpec[] = [];
  const spreadSpecs: CssSpec[] = [];
  for (const date of chinaDates) {
    const existing = coverage.get(date) ?? new Set<string>();
    const codes = EQUITY_CODES.slice(0, 7).filter((_, index) => !existing.has(EQUITY_FIELDS[index]!));
    if (codes.length) specs.push({ id: `equity-css-close/${date}`, date, codes, indicators: ['CLOSE'],
      options: `TradeDate=${date}`, targets: codes.map(code => EQUITY_FIELDS[EQUITY_CODES.indexOf(code)]!) });
    const fields = Object.entries(VALUATION_FIELDS).filter(([indicator, field]) =>
      indicator !== 'ERPMINUSM' && !existing.has(field));
    if (fields.length) specs.push({ id: `equity-css-valuation/${date}`, date, codes: ['800004.EI'],
      indicators: fields.map(([field]) => field),
      options: `EndDate=${date},TradeDate=${date},DelType=1`,
      targets: fields.map(([, field]) => field) });
    if (!existing.has('equity_bond_spread')) spreadSpecs.push({ id: `equity-bond-spread/${date}`,
      date, codes: [], indicators: [], options: '', targets: ['equity_bond_spread'] });
  }
  for (const date of usDates) {
    if (coverage.get(date)?.has('vix_close')) continue;
    specs.push({ id: `equity-css-vix/${date}`, date, codes: ['VIX.GI'], indicators: ['CLOSE'],
      options: `TradeDate=${date}`, targets: ['vix_close'] });
  }
  if (!specs.length && !spreadSpecs.length) return { stored: 0, failures: [], missing: [] };

  const references = await db(async client => {
    const dates = spreadSpecs.map(spec => spec.date);
    if (!dates.length) return { pe: new Map<string, number>(), yield10y: new Map<string, number>() };
    const [pe, yield10y] = await Promise.all([
      client.query<{ date: string; value: number | null }>(`SELECT observation_date::text AS date,
          numeric_value AS value FROM public.quant_input WHERE field='all_a_pe_ttm'
          AND observation_date=ANY($1::date[])`, [dates]),
      client.query<{ date: string; value: string }>(`SELECT observation_date::text AS date,
          value::text AS value FROM public.edb WHERE indicator_code='E1000180'
          AND observation_date=ANY($1::date[])`, [dates]),
    ]);
    return { pe: new Map(pe.rows.filter(row => row.value != null).map(row => [row.date, Number(row.value)])),
      yield10y: new Map(yield10y.rows.map(row => [row.date, Number(row.value)])) };
  });

  if (specs.length) {
    const plannedPoints = specs.reduce((sum, spec) => sum + spec.codes.length * spec.indicators.length, 0);
    let quotaError = '';
    try {
      const quota = tableSchema.parse(await requestCssQuota(request));
      if (quota.function !== 'DATASTATISTICS') throw new Error('Unexpected CSS quota table');
      const current = quota.rows.find(row => row.FUNCENAME === 'EM_CSS' && row.SECUTYPE === '全品种');
      const available = current?.AVAILABEDATA;
      const remaining = typeof available === 'string' || typeof available === 'number' ? Number(available) : NaN;
      if (current?.PERIOD !== 'W' || String(current?.STARTDATE ?? '') > endDate || String(current?.ENDDATE ?? '') < endDate ||
        !Number.isFinite(remaining) || remaining < plannedPoints + CSS_QUOTA_RESERVE) {
        quotaError = 'CSS quota unavailable or below reserved budget';
      }
    } catch (error) {
      quotaError = economicIndicatorErrorDetails(error).message;
    }
    if (quotaError) {
      return { stored: 0, failures: [{ source: 'equity-css-quota', error: quotaError }],
        missing: [...specs, ...spreadSpecs].map(spec => ({ source: spec.id, dates: [spec.date], fields: requiredFields(spec) })) };
    }
  }

  const fetched: FetchResult[] = [];
  for (const spec of specs) {
    try {
      const payload = tableSchema.parse(await request('/choice/css', new URLSearchParams({
        codes: spec.codes.join(','), indicators: spec.indicators.join(','), options: spec.options,
      })));
      if (payload.function !== 'CSS') throw new Error('Unexpected CSS table');
      const hash = createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex');
      const rows: QuantInput[] = [];
      for (const raw of payload.rows) {
        const code = String(raw.code ?? '');
        if (!spec.codes.includes(code)) throw new Error(`Unexpected CSS code ${code}`);
        for (const indicator of spec.indicators) {
          const target = indicator === 'CLOSE' ? EQUITY_FIELDS[EQUITY_CODES.indexOf(code)]
            : VALUATION_FIELDS[indicator];
          if (!target) throw new Error(`Unexpected CSS indicator ${indicator}`);
          const row = inputValue('equity', target, spec.date, raw[indicator], 'choice-api-css', spec.id, hash);
          if (row) rows.push(row);
        }
      }
      const missing = spec.targets.filter(field => !rows.some(row => row.field === field));
      fetched.push({ spec, rows, detail: missing.length ? `Missing fields: ${missing.join(',')}` : '',
        status: missing.length ? 'partial' : 'complete' });
    } catch (error) {
      fetched.push({ spec, rows: [], detail: economicIndicatorErrorDetails(error).message, status: 'failed' });
      // A failed paid source stops this run; the remaining gaps stay eligible on the next run.
      break;
    }
  }
  for (const spec of spreadSpecs) {
    const pe = fetched.flatMap(result => result.rows).find(row =>
      row.field === 'all_a_pe_ttm' && row.observationDate === spec.date)?.numericValue ?? references.pe.get(spec.date);
    const yield10y = references.yield10y.get(spec.date);
    if (pe == null || pe <= 0 || yield10y == null || !Number.isFinite(yield10y)) {
      fetched.push({ spec, rows: [], detail: 'Missing PETTM or same-day CGB 10Y yield', status: 'partial' });
      continue;
    }
    // Reproduces the existing CSD ERPMINUSM observations at EquityER=1,BondER=1.
    const value = Number((100 / pe - yield10y).toFixed(6));
    const hash = createHash('sha256').update(JSON.stringify({ PETTM: pe, CGB10Y: yield10y })).digest('hex');
    const row = inputValue('equity', 'equity_bond_spread', spec.date, value,
      'choice-api-css+edb', spec.id, hash);
    fetched.push({ spec, rows: row ? [row] : [], detail: row ? '' : 'Invalid calculated equity-bond spread',
      status: row ? 'complete' : 'partial' });
  }
  const stored = await db(async client => {
    const count = await persistQuantInputs(client, fetched.flatMap(result => result.rows), true);
    return count;
  });
  const failures = fetched.filter(result => result.detail).map(result => ({ source: result.spec.id, error: result.detail,
    kind: result.status === 'partial' ? 'data_gap' as const : 'execution' as const }));
  const missing = [...specs, ...spreadSpecs].flatMap(spec => {
    const result = fetched.find(item => item.spec === spec);
    const fields = spec.targets.filter(field => !result?.rows.some(row => row.field === field));
    return fields.length ? [{ source: spec.id, dates: [spec.date], fields }] : [];
  });
  if (fetched.length < specs.length + spreadSpecs.length) failures.push({ source: 'equity-css', error: 'CSS requests stopped after source failure', kind: 'execution' });
  return { stored, failures, missing };
}
