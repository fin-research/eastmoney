import { createHash } from 'node:crypto';
import type { WorkflowStep } from 'cloudflare:workers';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { syncBondHistory } from './bond-history-sync.ts';
import { workflowCssBudget } from './workflow-css-budget.ts';
import { withPostgres } from './postgres.ts';
import { encodeExchangeBondCode } from './exchange-bond-code.ts';

const STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' } as const;
export const DAILY_RECOVERY_POINTS = 162000;
type Pair = { date: string; code: string };
type Original = { scheduledTime: number; quant?: { groups?: Array<{ name: string; stored: number;
  failures: Array<{ kind?: string; error: string }>; missing: Array<{ reason?: string; dates?: string[]; codes?: string[] }> }> } };

export function dailyRecoveryIdentity(originalId: string) {
  const match = /^economic-indicator-sync-(\d{13})$/.exec(originalId);
  const time = Number(match?.[1]);
  if (!Number.isSafeInteger(time) || (time + 8 * 3600000) % 86400000 !== 0)
    throw Error('Daily recovery requires an original Shanghai midnight run');
  const date = new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  return { time, date, id: `bond-history-recovery-${time}`, opensAt: time + 9 * 3600000, closesAt: time + 21 * 3600000 };
}

// Decode the persisted request failure, never infer a quota outage from zero rows or a substring.
export function quotaUnavailable(original: Original): boolean {
  const history = original.quant?.groups?.find(group => group.name === '同步券商存续债估值');
  return history?.stored === 0 && history.failures.some(failure => {
    if (failure.kind !== 'execution') return false;
    try {
      const error = JSON.parse(failure.error);
      const body = JSON.parse(error.responseBody);
      return error.path === '/choice/data-statistics' && error.parameters?.funcName === 'EM_CSS'
        && error.status === 503 && body.error?.upstreamCode === 10000009;
    } catch { return false; }
  }) || false;
}

export function dailyRecoveryPairs(original: Original, originalId: string): Pair[] {
  const identity = dailyRecoveryIdentity(originalId);
  if (original.scheduledTime !== identity.time || !quotaUnavailable(original))
    throw Error('Original persisted quota failure unavailable');
  const first = new Date(identity.time + 8 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);
  const history = original.quant!.groups!.find(group => group.name === '同步券商存续债估值')!;
  const pairs = new Map<string, Pair>();
  for (const gap of history.missing.filter(gap => gap.reason === 'observation_absent')) {
    if (gap.dates?.length !== 1 || !gap.codes?.length) throw Error('Ambiguous original recovery matrix');
    const date = gap.dates[0]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first || date >= identity.date
      || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw Error('Recovery date outside original window');
    for (const code of gap.codes) {
      encodeExchangeBondCode(code);
      pairs.set(`${date}/${code}`, { date, code });
    }
  }
  if (!pairs.size || pairs.size > 6000) throw Error('Recovery matrix empty or exceeds daily scope');
  return [...pairs.values()].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

export async function startDailyBondRecovery(env: Cloudflare.Env, originalId: string, original: Original) {
  if (!quotaUnavailable(original)) return null;
  let identity;
  try { identity = dailyRecoveryIdentity(originalId); } catch { return null; }
  dailyRecoveryPairs(original, originalId);
  try {
    await env.ECONOMIC_INDICATOR_SYNC.create({ id: identity.id,
      params: { scheduledTime: identity.time, bondHistoryRecoveryOf: originalId }, locationHint: 'apac',
      retention: { successRetention: '30 days', errorRetention: '90 days' } });
  } catch (error) {
    try { await (await env.ECONOMIC_INDICATOR_SYNC.get(identity.id)).status(); }
    catch { throw error; }
  }
  return identity.id;
}

export async function runDailyBondRecovery(step: Pick<WorkflowStep, 'do' | 'sleepUntil'>, env: Cloudflare.Env,
  instanceId: string, originalId: string, request: DataApiRequest) {
  const identity = dailyRecoveryIdentity(originalId);
  if (instanceId !== identity.id) throw Error('Unexpected daily recovery instance');
  const waitForWindow = await step.do('记录同日估值补偿等待决策', STEP, async () => Date.now() < identity.opensAt);
  if (waitForWindow) await step.sleepUntil('等待同日有界估值补偿时点', new Date(identity.opensAt));
  const window = () => {
    if (Date.now() < identity.opensAt || Date.now() >= identity.closesAt) throw Error('Daily recovery outside Shanghai 09–21 window');
  };
  const original = await step.do('等待原实例终态只读核对',
    { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '30 seconds' }, async () => {
      window();
      const state = await (await env.ECONOMIC_INDICATOR_SYNC.get(originalId)).status();
      if (state.status !== 'complete') throw Error('Original Workflow not terminal');
      const output = state.output as Original;
      return { scheduledTime: output.scheduledTime, quant: { groups: (output.quant?.groups ?? [])
        .filter(group => group.name === '同步券商存续债估值') } };
    });
  const pairs = await step.do('核对原失败矩阵及零付费意图', STEP, async () => {
    window();
    const pairs = dailyRecoveryPairs(original, originalId);
    let cursor: string | undefined;
    do {
      const page = await env.EASTMONEY.list({ prefix: `data-observations/css-budget/${originalId}/history/`,
        limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) throw Error('Original paid history intent exists; refusing automatic replay');
      if (page.truncated && !page.cursor) throw Error('Incomplete history intent inventory');
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return pairs;
  });
  const allowedKeys = new Set(pairs.map(pair => `${pair.date}/${pair.code}`));
  const budget = workflowCssBudget(step, env.EASTMONEY, originalId, async (path, parameters, capture) => {
    window();
    return request(path, parameters, capture);
  }, identity.date, { history: DAILY_RECOVERY_POINTS });
  const scoped: DataApiRequest = async (path, parameters) => {
    window();
    if (path === '/choice/css') {
      const options = parameters.get('options') ?? '';
      const date = /^EndDate=(\d{4}-\d{2}-\d{2}),CredType=1$/.exec(options)?.[1];
      if (parameters.get('indicators') !== 'YIELDCNBD,BONDBALANCE,MATUCNBD' || !date
        || !(parameters.get('codes') ?? '').split(',').every(code => allowedKeys.has(`${date}/${code}`)))
        throw Error('Request outside original date/code matrix');
    } else if (path !== '/choice/data-statistics' || parameters.get('funcName') !== 'EM_CSS')
      throw Error('Unexpected recovery source');
    return budget('history')(path, parameters);
  };
  return step.do('执行唯一同日估值补偿', STEP, async () => {
    window();
    const result = await syncBondHistory(scoped,
      operation => withPostgres(env.HYPERDRIVE.connectionString, 'bond-history-daily-recovery', operation),
      identity.date, [...new Set(pairs.map(pair => pair.date))], identity.date, undefined, pairs);
    return { ...result, status: result.failures.length || result.missing.length ? 'partial' : 'complete',
      originalInstanceId: originalId, originalDate: identity.date, scopePairs: pairs.length,
      scopeSha256: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'), maximumPoints: DAILY_RECOVERY_POINTS };
  });
}
