import type { WorkflowStep } from 'cloudflare:workers';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { quantMarketRequests, fetchQuantMarketInputs, fetchIssueSpreads, type QuantRequest } from './quant-market-sync.ts';
import { persistQuantInputs } from './quant-input-repository.ts';
import { withPostgres } from './postgres.ts';
import { EQUITY_FIELDS, VALUATION_FIELDS } from './quant-input-contract.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';
import { runFundReportWindowSync } from './quant-fund-report-run.ts';
import { syncIssuePricing } from './quant-pricing.ts';
import { upsertBondIssuance, updateBondSpread } from './bond-issuance-repository.ts';
import { syncBrokerCurve } from './broker-curve-sync.ts';
import { syncQuantEquityCss, tradingDates } from './quant-equity-css.ts';
import { syncBondHistory } from './bond-history-sync.ts';
import { syncBondPlacement } from './bond-placement-sync.ts';
import { issuanceObservationRequests, type ObservationArchiveResult } from './issuance-observation-request.ts';
import { saveApplicationReceipt, saveLiveObservationManifest } from './issuance-observation-store.ts';
import type { QuantSyncFailure } from './quant-sync-result.ts';
import { workflowCssBudget } from './workflow-css-budget.ts';

type Database = <T>(operation: Parameters<typeof withPostgres<T>>[2]) => Promise<T>;
type Missing = { source: string; dates?: string[]; fields?: string[]; codes?: string[]; reason?: string };
type Result = {
  stored: number;
  failures: QuantSyncFailure[];
  missing?: Missing[];
  notApplicable?: Array<{date:string;code:string;reason:'not_issued'}>;
  requestedDates?: string[];
  skippedDates?: string[];
  observations?: ObservationArchiveResult[];
  application_receipt?: string;
};
type GroupResult = Result & { name: string; status: 'complete' | 'partial'; missing: Missing[] };
const PAID_FETCH = { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' } as const;

export async function runQuantInputSync(
  step: Pick<WorkflowStep, 'do'>,
  env: Pick<Cloudflare.Env, 'HYPERDRIVE' | 'EASTMONEY' | 'CHOICE_RPC' | 'CHOICE_RPC_TOKEN' | 'CHOICE_FAST_LIMIT' | 'CHOICE_OTHER_LIMIT'>,
  scheduledTime: number,
  request: DataApiRequest,
  instanceId?: string,
  economicReady: Promise<void> = Promise.resolve(),
) {
  const endDate = new Date(scheduledTime + 8 * 3600_000).toISOString().slice(0, 10);
  const startDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const completedDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const db: Database = (operation) => withPostgres(env.HYPERDRIVE.connectionString, 'quant-input-sync', operation);
  const css = workflowCssBudget(step, env.EASTMONEY, instanceId ?? `quant-${scheduledTime}`, request, endDate);
  const issuanceRequest = css('issuance');
  // The midnight run cannot observe issuance for the day that has just started.
  const specs = quantMarketRequests(startDate, completedDate);
  // Independent groups start together; dependent groups await committed inputs.
  // Daily primary queries and dependent issuance spreads
  // stay inside their business step; paid queries are never automatically replayed.
  // BondTradingStatistics is not licensed; secondary remains manual-backfill only.
  // The public industry curve is an independent step and makes no Choice request.
  const calendar = step.do('读取已结束上交所交易日', PAID_FETCH, async () => {
    const first = new Date(Date.parse(`${endDate}T00:00:00Z`) - 14 * 86400000).toISOString().slice(0, 10);
    return tradingDates(env, first, completedDate, 'CNSESH');
  }).then(dates => {
    if (!dates.length) throw new Error('Completed trading calendar unavailable');
    return dates;
  });
  // Consumers report this shared failure in their own business group.
  void calendar.catch(() => undefined);
  const issuance = group('同步 Quant 券商发行与利差', async () => {
      const observations = instanceId ? issuanceObservationRequests(env.EASTMONEY, instanceId, endDate, issuanceRequest) : undefined;
      const market = await syncMarketGroup('issue', observations?.request);
      const spreads = await source('issue-spread', syncSpreads);
      const pricing = await source('issue-pricing', () => syncIssuePricing(issuanceRequest, db, endDate, observations?.forBonds));
      const placement = await source('bond-placement', () => syncBondPlacement(issuanceRequest, db, endDate, 200, observations?.forBonds));
      const result = combine([market, spreads, pricing, placement]);
      if (!observations || !instanceId) return result;
      result.observations = observations.results;
      result.failures.push(...observations.results.filter(r => r.status === 'failed').map(r => ({ source: `observation-archive:${r.source}`, error: r.error! })));
      try {
        await saveLiveObservationManifest(env.EASTMONEY,instanceId,observations.results);
        result.application_receipt = await saveApplicationReceipt(env.EASTMONEY,instanceId, {
          mode: 'live', original_instance: instanceId,
          observations: observations.results,
          sources: [{ source: 'issue-detail', result: market }, { source: 'issue-pricing', result: pricing }, { source: 'bond-placement', result: placement }]
            .map(({ source, result }) => ({ source, stored: result.stored, status: result.failures.length || result.missing?.length ? 'partial' : 'complete' })),
        });
      } catch { result.failures.push({ source: 'observation-application', error: 'Database summary was not durably archived' }); }
      return result;
    });
  const curve = group('同步中债券商曲线', () => source('broker-curve', async () => {
      const curve = await db(client => syncBrokerCurve(client, endDate));
      return { stored: curve.stored, failures: curve.failures,
        missing: curve.missingDates.map(date => ({ source: 'broker-curve', dates: [date], fields: ['AAA_CURVE'] })) };
    }));
  const results = await Promise.all([
    group('同步 Quant 权益行情与估值', () => syncQuantEquityCss(env, css('equity'), startDate, endDate), [economicReady]),
    group('同步 Quant 一级市场', () => syncMarketGroup('primary')),
    issuance,
    group('同步 Quant 资金日报', () => source('fund-reports', async () => {
      const dates = await calendar;
      return runFundReportWindowSync(env.EASTMONEY, db, dates);
    })),
    curve,
    group('同步券商存续债估值', () => source('bond-history', async () => {
      const dates = (await calendar).filter(date => date >= startDate && date < endDate);
      return syncBondHistory(css('history'), db, endDate, dates);
    }), [issuance]),
  ]);
  const result = combine(results);
  return { status: result.failures.length || result.missing?.length ? 'partial' as const : 'complete' as const, ...result, groups: results };

  function combine(results: Result[]): Result {
    return { stored: results.reduce((sum, result) => sum + result.stored, 0),
      failures: results.flatMap(result => result.failures), missing: results.flatMap(result => result.missing ?? []) };
  }

  async function group(name: string, operation: () => Promise<Result>, prerequisites: Promise<unknown>[] = []): Promise<GroupResult> {
    await Promise.all(prerequisites);
    try {
      return await step.do(name, { ...PAID_FETCH, timeout: '10 minutes' }, async () => {
        const result = await operation();
        return { ...result, name, status: result.failures.length || result.missing?.length ? 'partial' as const : 'complete' as const,
          failures: result.failures.map(failure => ({ ...failure, kind: failure.kind ?? 'execution' as const })),
          missing: (result.missing ?? []).map(gap => ({ ...gap, reason: gap.reason ?? 'not_returned' })) };
      });
    } catch (error) {
      return { name, status: 'partial', stored: 0, missing: [],
        failures: [{ source: name, error: economicIndicatorErrorDetails(error).message, kind: 'execution' }] };
    }
  }

  async function source(id: string, operation: () => Promise<Result>): Promise<Result> {
    try { return await operation(); }
    catch (error) {
      const message = economicIndicatorErrorDetails(error).message;
      return { stored: 0, failures: [{ source: id, error: message, kind: 'execution' }] };
    }
  }

  async function syncMarketGroup(dataset: string, sourceRequest: DataApiRequest = request): Promise<Result> {
    const batches: Array<{ spec: QuantRequest; rows: Awaited<ReturnType<typeof fetchQuantMarketInputs>>; detail: string }> = [];
    const failures: Result[] = [];
    const candidates = specs.filter(spec => spec.dataset === dataset);
    const coverage = dataset === 'primary' ? await db(async client => {
      const result = await client.query<{ date: string; fields: string[]; issue_count: string | number | null }>(`SELECT observation_date::text AS date,
          array_agg(DISTINCT field ORDER BY field) AS fields,
          max(numeric_value) FILTER (WHERE field='ISSUE_NUM') AS issue_count
        FROM public.quant_input WHERE observation_date BETWEEN $1::date AND $2::date
          AND field = ANY($3::text[])
        GROUP BY observation_date ORDER BY observation_date`, [startDate, endDate, expectedFields(candidates[0]!)]);
      return new Map(result.rows.map(row => [row.date, { fields: row.fields, issueCount: row.issue_count }]));
    }) : new Map<string, { fields: string[]; issueCount: string | number | null }>();
    const requestedDates: string[] = [], skippedDates: string[] = [];
    // Existing dates are never charged again. Incomplete existing fields are
    // reported in this step's output; they do not trigger another daily CTR call.
    for (const spec of candidates) {
      const date = dataset === 'primary' ? spec.id.slice('primary-'.length) : undefined;
      if (date && coverage.has(date)) {
        skippedDates.push(date);
        const existing = coverage.get(date)!;
        const missing = missingFields(spec, existing.fields, existing.issueCount);
        if (missing.length) failures.push({ stored: 0,
          failures: [{ source: spec.id, error: `Stored date has missing fields: ${missing.join(',')}`, kind: 'data_gap' }],
          missing: [{ source: spec.id, dates: [date], fields: missing, reason: 'stored_fields_incomplete' }] });
        continue;
      }
      if (date) requestedDates.push(date);
      const result = await source(spec.id, async () => {
        const rows = await fetchQuantMarketInputs(sourceRequest, spec, startDate, completedDate);
        const missing = dataset === 'issue' && !rows.length ? [] : missingFields(spec, rows.map(row => row.field),
          rows.find(row => row.field === 'ISSUE_NUM')?.numericValue);
        const detail = !rows.length && dataset !== 'issue' ? 'No observations returned' : missing.length ? `Missing fields: ${missing.join(',')}` : '';
        batches.push({ spec, rows, detail });
        return { stored: 0, failures: detail ? [{ source: spec.id, error: detail, kind: 'data_gap' }] : [],
          missing: missing.length ? [{ source: spec.id, ...(date ? { dates: [date] } : {}), fields: missing,
            reason: rows.length ? 'source_fields_incomplete' : 'source_returned_empty' }] : [] };
      });
      if (result.failures.length && !result.missing?.length) {
        result.missing = [{ source: spec.id, ...(date ? { dates: [date] } : {}), fields: expectedFields(spec) }];
      }
      failures.push(result);
    }
    const dates = dataset === 'primary' ? { requestedDates, skippedDates } : {};
    if (!batches.length) return { ...combine(failures), ...dates };
    const stored = await source(dataset, async () => {
      const count = await db(async client => {
        const rows = batches.flatMap(batch => batch.rows);
        return dataset === 'issue' ? upsertBondIssuance(client, rows) : persistQuantInputs(client, rows);
      });
      return { stored: count, failures: [] };
    });
    return { ...combine([...failures, stored]), ...dates };
  }

  async function syncSpreads(): Promise<Result> {
    const bonds = await db(async (client) => {
      const result = await client.query<{ code: string; date: string }>(`SELECT bond_code AS code,issue_date::text AS date
        FROM public.bond_issuance WHERE issue_spread_bp IS NULL
          AND issue_spread_invalid_code=false
        ORDER BY issue_date DESC,bond_code LIMIT 64`);
      return result.rows;
    });
    if (!bonds.length) return { stored: 0, failures: [] };
    const { rows, invalidCodes } = await fetchIssueSpreads(issuanceRequest, bonds);
    const detail = rows.length < bonds.length
      ? `${bonds.length - rows.length} spreads unavailable; ${invalidCodes.length} invalid codes excluded from automatic retries` : '';
    const stored = await db(async (client) => {
      let count = 0;
      for (const row of rows) count += await updateBondSpread(client, row.entityKey, row.numericValue);
      for (const bond of bonds.filter((bond) => invalidCodes.includes(bond.code))) {
        await updateBondSpread(client, bond.code, null, true);
      }
      return count;
    });
    const missing = bonds.filter(bond => !rows.some(row => row.entityKey === bond.code && row.observationDate === bond.date));
    return { stored, failures: detail ? [{ source: 'issue-spread', error: detail, kind: 'data_gap' }] : [],
      missing: missing.map(bond => ({ source: 'issue-spread', codes: [bond.code], dates: [bond.date], fields: ['ISSUECREDITSPREAD'],
        reason: invalidCodes.includes(bond.code) ? 'invalid_code' : 'not_returned' })) };
  }
}

function expectedFields(spec: QuantRequest): string[] {
  if (spec.id === 'equity-close') return EQUITY_FIELDS;
  if (spec.id === 'equity-valuation') return Object.values(VALUATION_FIELDS);
  return spec.fields.filter((field) => field !== 'ISSUE_DATE');
}

function missingFields(spec: QuantRequest, present: string[], issueCount?: string | number | null): string[] {
  // Weighted issuance cost is undefined when the source reports no issuance.
  const noIssuance = spec.dataset === 'primary' && issueCount != null && Number(issueCount) === 0;
  return expectedFields(spec).filter(field => !(noIssuance && field === 'WEIGHTED_COST') && !present.includes(field));
}
