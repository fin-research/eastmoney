import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowStep } from 'cloudflare:workers';
import type { EconomicIndicatorGroupResult } from './economic-indicator-run.ts';

const requestSchema = z.object({
  id: z.string(), source: z.literal('dm-funding-history'), path: z.literal('/cfets-histories'),
  parameters: z.record(z.string(), z.string()), codes: z.array(z.string()),
});
const groupSchema = z.object({
  name: z.literal('同步 DM 资金面'), status: z.enum(['complete', 'partial', 'failed']),
  missing: z.array(z.object({ source: z.string(), codes: z.array(z.string()) })),
  requests: z.array(z.object({ id: z.string(), source: z.literal('dm-funding-history'), codes: z.array(z.string()),
    status: z.enum(['complete', 'failed']), storedRows: z.number().int().nonnegative() })).length(6),
  failures: z.array(z.object({ step: z.string(), request: requestSchema,
    error: z.object({ name: z.string(), message: z.string() }) })),
  rowCount: z.number().int().nonnegative(), asOf: z.string(), returnedCodes: z.array(z.string()),
  pageCount: z.number().int().nonnegative(),
});

export type DmFundingSyncParams = { scheduledTime: number; parentInstanceId: string; notifyParent?: boolean };
const RESULT_EVENT = 'dm-funding-result';
export function dmFundingChildId(parentInstanceId: string): string {
  return `dm-${createHash('sha256').update(parentInstanceId).digest('hex')}`;
}

/** A distinct instance owns the six DM requests and their retries (at most 18 fetches).
 * Durable steps alone do not establish a separate subrequest budget. */
export async function runDmFundingChild(
  step: Pick<WorkflowStep, 'do' | 'waitForEvent'>,
  workflow: Workflow<DmFundingSyncParams>,
  parentInstanceId: string,
  scheduledTime: number,
): Promise<EconomicIndicatorGroupResult> {
  const id = dmFundingChildId(parentInstanceId);
  await step.do('启动 DM 资金面子流程', { retries: { limit: 0, delay: '1 second' }, timeout: '30 seconds' }, async () => {
    try {
      await workflow.create({ id, params: { scheduledTime, parentInstanceId, notifyParent: true }, locationHint: 'apac' });
    } catch (error) {
      // A create response can be lost after acceptance. Adopt only a verifiable
      // existing instance; do not create another instance on parent recovery.
      try {
        const state = await (await workflow.get(id)).status();
        if (state.status === 'errored' || state.status === 'terminated') throw error;
      }
      catch { throw error; }
    }
    return id;
  });
  // Events arriving before this wait are buffered. No repeated status calls:
  // sleeping/durable steps do not establish a new subrequest budget.
  const event = await step.waitForEvent('等待 DM 资金面子流程结果', { type: RESULT_EVENT, timeout: '15 minutes' });
  return z.object({ parentInstanceId: z.literal(parentInstanceId), childInstanceId: z.literal(id),
    scheduledTime: z.literal(scheduledTime), group: groupSchema }).parse(event.payload).group;
}

/** Retrying this durable step only resends the committed result, never fetches DM again. */
export async function notifyDmFundingParent(step: Pick<WorkflowStep, 'do'>,
  workflow: Workflow, childInstanceId: string, params: DmFundingSyncParams,
  group: EconomicIndicatorGroupResult) {
  if (!params.notifyParent) return;
  if (childInstanceId !== dmFundingChildId(params.parentInstanceId)) throw new Error('DM child identity mismatch');
  await step.do('通知父流程 DM 资金面结果',
    { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, async () => {
      const parent = await workflow.get(params.parentInstanceId);
      await parent.sendEvent({ type: RESULT_EVENT, payload: { parentInstanceId: params.parentInstanceId,
        childInstanceId, scheduledTime: params.scheduledTime, group } });
    });
}
