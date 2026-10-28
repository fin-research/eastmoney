import type { DatabaseClient } from './postgres.ts';
import { economicIndicatorErrorDetails } from './economic-indicator-request.ts';

const CURVE_CODE = '5781a1ff7651967e0176978d957b7346';
const CURVE_NAME = '中债证券公司债收益率曲线(AAA)';
const OFFICIAL_NAME = `${CURVE_NAME}(到期)`;
const SEARCH_URL = 'https://yield.chinabond.com.cn/cbweb-mn/yc/searchYc';
const DAY_MS = 86_400_000;
const REQUIRED_TENORS = [0.25, 0.5, 1, 2, 3, 5, 10];
type CurveNode = { tenorYears: number; yieldPct: number };

function transientCurveError(error: unknown): boolean {
  return error instanceof Error && (['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)
    || /^ChinaBond curve HTTP 5\d\d$/.test(error.message));
}

function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function weekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

export async function fetchBrokerCurve(date: string, fetcher: typeof fetch = fetch): Promise<CurveNode[] | null> {
  const body = new URLSearchParams({
    xyzSelect: 'txy', workTimes: date, dxbj: '0', qxll: '0,', yqqxN: 'N', yqqxK: 'K',
    ycDefIds: CURVE_CODE, wrjxCBFlag: '0', locale: 'zh_CN',
  });
  const response = await fetcher(SEARCH_URL, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ChinaBond curve HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || payload.length > 1) throw new Error('Invalid ChinaBond curve response');
  if (!payload.length) return null;
  const series = payload[0] as Record<string, unknown>;
  if (series.ycDefId !== CURVE_CODE || series.ycDefName !== OFFICIAL_NAME || series.worktime !== date
    || !Array.isArray(series.seriesData)) throw new Error('Mismatched ChinaBond curve date or identity');
  const nodes: CurveNode[] = [];
  const tenors = new Set<number>();
  for (const value of series.seriesData) {
    if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid ChinaBond broker AAA curve node');
    const tenorYears = Number(value[0]);
    const yieldPct = Number(value[1]);
    if (!Number.isFinite(tenorYears) || tenorYears < 0 || !Number.isFinite(yieldPct)
      || yieldPct <= 0 || yieldPct >= 20) throw new Error('Invalid ChinaBond broker AAA curve node');
    // The official series contains a zero-tenor anchor; the database accepts positive tenors.
    if (tenorYears === 0) continue;
    if (tenors.has(tenorYears)) throw new Error('Duplicate ChinaBond broker AAA curve tenor');
    tenors.add(tenorYears);
    nodes.push({ tenorYears, yieldPct });
  }
  if (REQUIRED_TENORS.some(tenor => !tenors.has(tenor))) {
    throw new Error('Incomplete ChinaBond broker AAA curve');
  }
  return nodes;
}

/** Replay only recent missing dates. Empty official responses are normal on exchange holidays. */
export async function syncBrokerCurve(
  client: DatabaseClient,
  asOfDate: string,
  load: (date: string) => Promise<CurveNode[] | null> = fetchBrokerCurve,
): Promise<{ stored: number; missingDates: string[]; failures: Array<{ source: string; error: string }> }> {
  const target = addDays(asOfDate, -1);
  const windowStart = addDays(target, -13);
  const result = await client.query<{ latest_date: string | null; complete_dates: string[] }>(
    `SELECT max(observation_date)::text AS latest_date,
      COALESCE(array_agg(observation_date::text ORDER BY observation_date)
        FILTER (WHERE observation_date >= $3::date), '{}') AS complete_dates FROM (
      SELECT observation_date FROM public.bond_industry_curve
      WHERE curve_code=$1 AND observation_date < $2::date
      GROUP BY observation_date
      HAVING count(*) FILTER (WHERE tenor_years IN (0.25,0.5,1,2,3,5,10)) = 7
    ) complete_dates`, [CURVE_CODE, asOfDate, windowStart]);
  const latest = result.rows[0]?.latest_date ?? null;
  if (latest && (Date.parse(target) - Date.parse(latest)) / DAY_MS > 14) {
    throw new Error('Broker curve gap exceeds 14 days; use controlled historical replay');
  }
  const complete = new Set(result.rows[0]?.complete_dates ?? []);
  const candidates: string[] = [];
  for (let date = latest ? windowStart : target; date <= target; date = addDays(date, 1)) {
    if (weekday(date) && !complete.has(date)) candidates.push(date);
  }
  const missingDates: string[] = [];
  const failures: Array<{ source: string; error: string }> = [];
  let stored = 0;
  for (const [index, date] of candidates.entries()) {
    try {
      let value: CurveNode[] | null;
      try { value = await load(date); }
      catch (error) {
        if (!transientCurveError(error)) throw error;
        value = await load(date); // One bounded retry; this source has no Choice charge.
      }
      if (value === null) { missingDates.push(date); continue; }
      const rows = value.map(node => ({
        date, tenor_years: node.tenorYears, yield_pct: node.yieldPct, node_label: `${node.tenorYears}y`,
      }));
      const write = await client.query(`INSERT INTO public.bond_industry_curve
      (curve_code,curve_name,observation_date,tenor_years,yield_pct,node_label)
    SELECT $1,$2,x.date::date,x.tenor_years,x.yield_pct,x.node_label
    FROM jsonb_to_recordset($3::jsonb) AS x(date text,tenor_years double precision,
      yield_pct double precision,node_label text)
    ON CONFLICT (curve_code,observation_date,tenor_years) DO UPDATE SET
      curve_name=excluded.curve_name,yield_pct=excluded.yield_pct,node_label=excluded.node_label
    WHERE (bond_industry_curve.curve_name,bond_industry_curve.yield_pct,bond_industry_curve.node_label)
      IS DISTINCT FROM (excluded.curve_name,excluded.yield_pct,excluded.node_label)`,
      [CURVE_CODE, CURVE_NAME, JSON.stringify(rows)]);
      stored += write.rowCount ?? 0;
    } catch (error) {
      failures.push({ source: 'broker-curve', error: `${date}: ${economicIndicatorErrorDetails(error).message}` });
      // Keep the failure and unqueried gaps; already complete dates are not missing.
      missingDates.push(...candidates.slice(index));
      break;
    }
  }
  return { stored, missingDates, failures };
}
