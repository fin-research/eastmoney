import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { WorkflowStep } from 'cloudflare:workers';
import type { DataApiRequest } from './economic-indicator-sync.ts';
import { syncBondHistory } from './bond-history-sync.ts';
import { workflowCssBudget } from './workflow-css-budget.ts';
import { withPostgres } from './postgres.ts';
import { encodeExchangeBondCode } from './exchange-bond-code.ts';

// A single authorized production repair, not a second daily all-source run.
export const BOND_RECOVERY_ORIGINAL = 'economic-indicator-sync-1792684800000';
export const BOND_RECOVERY_INSTANCE = 'bond-history-recovery-1792684800000-v2';
export const BOND_RECOVERY_DATE = '2026-10-22';
export const BOND_RECOVERY_POINTS = 10000;
const STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' } as const;
const originalOutput = z.object({ scheduledTime: z.literal(1792684800000), status: z.literal('partial'),
  quant: z.object({ groups: z.array(z.object({ name: z.string(), missing: z.array(z.object({
    reason: z.string().optional(), dates: z.array(z.string()).optional(), codes: z.array(z.string()).optional(),
  })).optional() })) }) });

export function bondRecoveryCodes(raw: unknown): string[] {
  const original = originalOutput.parse(raw);
  const group = original.quant.groups.find(group => group.name === '同步券商存续债估值');
  const codes = [...new Set((group?.missing ?? []).filter(gap => gap.reason === 'observation_absent'
    && gap.dates?.length === 1 && gap.dates[0] === BOND_RECOVERY_DATE).flatMap(gap => gap.codes ?? []))].sort();
  if (!codes.length || codes.length * 3 > BOND_RECOVERY_POINTS)
    throw Error('Original failed bond-history scope unavailable or exceeds fixed repair budget');
  for (const code of codes) encodeExchangeBondCode(code);
  return codes;
}

export function restrictBondRecovery(request: DataApiRequest, codes: string[]): DataApiRequest {
  return async (path, parameters) => {
    if (path === '/choice/data-statistics' && parameters.get('funcName') === 'EM_CSS') return request(path, parameters);
    if (path !== '/choice/css' || parameters.get('indicators') !== 'YIELDCNBD,BONDBALANCE,MATUCNBD'
      || parameters.get('options') !== `EndDate=${BOND_RECOVERY_DATE},CredType=1`
      || !parameters.get('codes') || parameters.get('codes')!.split(',').some(code => !codes.includes(code)))
      throw Error('Request outside fixed bond-history recovery scope');
    return request(path, parameters);
  };
}

export async function runBondHistoryWorkflowRecovery(step: Pick<WorkflowStep, 'do'>, env: Cloudflare.Env,
  instanceId: string, originalInstanceId: string, request: DataApiRequest) {
  if (instanceId !== BOND_RECOVERY_INSTANCE || originalInstanceId !== BOND_RECOVERY_ORIGINAL)
    throw Error('Unapproved bond-history recovery instance');
  const codes = await step.do('读取固定估值补偿范围', STEP, async () => {
    const original = await env.ECONOMIC_INDICATOR_SYNC.get(originalInstanceId);
    const state = await original.status();
    if (state.status !== 'complete') throw Error('Original bond-history Workflow has not completed');
    return bondRecoveryCodes(state.output);
  });
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const budgeted = workflowCssBudget(step, env.EASTMONEY, instanceId, request, date, { history: BOND_RECOVERY_POINTS });
  const scoped = restrictBondRecovery(budgeted('history'), codes);
  const result = await step.do('定向恢复10月22日逐债估值', STEP, () => syncBondHistory(scoped,
    operation => withPostgres(env.HYPERDRIVE.connectionString, 'bond-history-workflow-recovery', operation),
    '2026-10-23', [BOND_RECOVERY_DATE], date, codes));
  return step.do('汇总逐债估值定向恢复', { retries: { limit: 0, delay: '1 second' } }, async () => ({
    ...result, status: result.failures.length || result.missing.length ? 'partial' : 'complete',
    originalInstanceId, targetDate: BOND_RECOVERY_DATE, scopeCodes: codes.length,
    scopeSha256: createHash('sha256').update(JSON.stringify(codes)).digest('hex'), maximumPoints: BOND_RECOVERY_POINTS,
  }));
}
