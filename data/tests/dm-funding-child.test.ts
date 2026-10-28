import { expect, test, vi } from 'vitest';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { EconomicIndicatorGroupResult } from '../src/sync/economic-indicator-run.ts';
import { dmFundingChildId, notifyDmFundingParent, runDmFundingChild } from '../src/sync/dm-funding-child.ts';
import { economicIndicatorRequests, runEconomicIndicatorSync } from '../src/sync/economic-indicator-run.ts';

const scheduledTime = Date.parse('2026-10-08T16:00:33Z');
const parent = 'economic-indicator-sync-1791475233000';
const specs = economicIndicatorRequests(scheduledTime).filter(s => s.source === 'dm-funding-history');
function group(status: EconomicIndicatorGroupResult['status'] = 'complete'): EconomicIndicatorGroupResult {
  return { name: '同步 DM 资金面', status, missing: [], failures: [], rowCount: 6, asOf: '2026-10-08',
    returnedCodes: specs.flatMap(s => s.codes), pageCount: 6,
    requests: specs.map(s => ({ id: s.id, source: s.source, codes: s.codes, status: 'complete', storedRows: 1 })) };
}
function fixture(result = group()) {
  const status = vi.fn().mockResolvedValue({ status: 'running' });
  const create = vi.fn(async () => ({ id: dmFundingChildId(parent) }));
  const workflow = { create, get: vi.fn(async () => ({ status })) } as unknown as Workflow;
  const names: string[] = [];
  const waitForEvent = vi.fn().mockResolvedValue({ payload: { parentInstanceId: parent,
    childInstanceId: dmFundingChildId(parent), scheduledTime, group: result } });
  const step = { do: vi.fn(async (name: string, _config: WorkflowStepConfig, operation: () => Promise<unknown>) => {
    names.push(name); return operation();
  }), waitForEvent } as unknown as Pick<WorkflowStep, 'do' | 'waitForEvent'>;
  return { workflow, step, create, status, names, waitForEvent };
}
test('child dispatch uses a stable id and one event wait without status polls; parent receives validated business failure', async () => {
  const result = group('partial');
  const h = fixture(result);
  expect(await runDmFundingChild(h.step, h.workflow, parent, scheduledTime)).toEqual(result);
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ id: dmFundingChildId(parent), params: { parentInstanceId: parent, scheduledTime, notifyParent: true } }));
  expect(dmFundingChildId('x'.repeat(200)).length).toBeLessThanOrEqual(100);
  expect(new Set(h.names).size).toBe(h.names.length);
  expect(h.waitForEvent).toHaveBeenCalledExactlyOnceWith('等待 DM 资金面子流程结果', { type: 'dm-funding-result', timeout: '15 minutes' });
  expect(h.workflow.get).not.toHaveBeenCalled();
});
test('lost create response adopts existing child without another dispatch', async () => {
  const h = fixture();
  h.create.mockRejectedValueOnce(new Error('create response lost'));
  await runDmFundingChild(h.step, h.workflow, parent, scheduledTime);
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.status).toHaveBeenCalledOnce();
});
test('failed adoption retains original create error', async () => {
  const h = fixture();
  h.create.mockRejectedValue(new Error('dispatch denied'));
  h.status.mockRejectedValue(new Error('not found'));
  await expect(runDmFundingChild(h.step, h.workflow, parent, scheduledTime)).rejects.toThrow('dispatch denied');
});
test.each(['errored', 'terminated'])('lost create reply cannot adopt a child already %s', async state => {
  const h = fixture(); h.create.mockRejectedValue(new Error('lost create response'));
  h.status.mockResolvedValue({status: state});
  await expect(runDmFundingChild(h.step, h.workflow, parent, scheduledTime)).rejects.toThrow('lost create response');
  expect(h.status).toHaveBeenCalledOnce(); expect(h.waitForEvent).not.toHaveBeenCalled();
});
test.each(['parentInstanceId', 'childInstanceId', 'scheduledTime', 'group'])('event with mismatched %s cannot enter the aggregate', async key => {
  const h = fixture();
  h.waitForEvent.mockResolvedValue({ payload: { parentInstanceId: parent, childInstanceId: dmFundingChildId(parent), scheduledTime, group: group(), [key]: 'wrong' } });
  await expect(runDmFundingChild(h.step, h.workflow, parent, scheduledTime)).rejects.toThrow();
});
test.each(['event timeout', 'Too many subrequests by single Worker invocation'])('waiting preserves %s without polling or recreating the child', async message => {
  const h = fixture(); const error = new Error(message); h.waitForEvent.mockRejectedValue(error);
  await expect(runDmFundingChild(h.step, h.workflow, parent, scheduledTime)).rejects.toBe(error);
  expect(h.status).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledOnce();
});

test('a failed completion notification retries only sending the committed result', async () => {
  const sendEvent = vi.fn().mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue(undefined);
  const workflow = { get: vi.fn(async () => ({ sendEvent })) } as unknown as Workflow;
  const result = group('failed');
  const step = { do: async (_name: string, config: WorkflowStepConfig, operation: () => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); } catch (error) { if (attempt >= config.retries!.limit) throw error; }
    }
  } } as unknown as Pick<WorkflowStep, 'do'>;
  await notifyDmFundingParent(step, workflow, dmFundingChildId(parent), { parentInstanceId: parent, scheduledTime, notifyParent: true }, result);
  expect(sendEvent).toHaveBeenCalledTimes(2);
  expect(sendEvent).toHaveBeenLastCalledWith({ type: 'dm-funding-result', payload: {
    parentInstanceId: parent, childInstanceId: dmFundingChildId(parent), scheduledTime, group: result,
  } });
});

test('legacy child does not notify an old parent and an incorrect child cannot send a result', async () => {
  const step = { do: vi.fn() } as unknown as Pick<WorkflowStep, 'do'>;
  const workflow = { get: vi.fn() } as unknown as Workflow;
  await notifyDmFundingParent(step, workflow, dmFundingChildId(parent), { parentInstanceId: parent, scheduledTime }, group());
  await expect(notifyDmFundingParent(step, workflow, 'wrong', { parentInstanceId: parent, scheduledTime, notifyParent: true }, group())).rejects.toThrow('identity');
  expect(step.do).not.toHaveBeenCalled(); expect(workflow.get).not.toHaveBeenCalled();
});
test('isolated DM retries initial handshake failures, writes all six series and makes no Choice call', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const counts = new Map<string, number>();
  const request = vi.fn(async (path, params) => {
    expect(path).toBe('/cfets-histories');
    const code = params.get('bondCode'); counts.set(code, (counts.get(code) ?? 0) + 1);
    if (code === 'R007' && counts.get(code) === 1) throw new Error('handshake timeout');
    return { hasNextPage: false, rows: [{ bondCode: code, capitalTime: Date.parse('2026-10-08T08:00:00Z'), weightedYield: 1.4, lastPrice: 1.5 }] };
  });
  const persist = vi.fn(async rows => ({ rowCount: rows.length, asOf: '2026-10-08' }));
  const step = { do: async (_name: string, config: WorkflowStepConfig, operation: (ctx: { attempt: number }) => Promise<unknown>) => {
    for (let attempt = 1; ; attempt++) {
      try { return await operation({ attempt }); } catch (e) { if (attempt > config.retries!.limit) throw e; }
    }
  } } as unknown as Pick<WorkflowStep, 'do'>;
  try {
    const result = await runEconomicIndicatorSync(step, 'child', scheduledTime, request, persist, { dmOnly: true });
    expect(result.status).toBe('complete'); expect(result.storedRows).toBe(6);
    expect(request).toHaveBeenCalledTimes(12); expect(persist).toHaveBeenCalledOnce();
    expect(result.groups).toHaveLength(1); expect(result.requestedIndicators).toBe(6);
  } finally { vi.restoreAllMocks(); }
});
test('parent delegation merges child rows and errors without issuing DM requests or nesting steps', async () => {
  const child = group('failed'); child.rowCount = 0;
  child.failures = specs.map(spec => ({ step: child.name, request: spec, error: { name: 'Error', message: 'unavailable' } }));
  const request = vi.fn(async path => { expect(path).toBe('/choice/edb'); return { function: 'EDB', fields: [], rows: [] }; });
  const names: string[] = [];
  const step = { do: async (name: string, _config: WorkflowStepConfig, operation: (ctx: { attempt: number }) => Promise<unknown>) => {
    names.push(name); return operation({ attempt: 1 });
  } } as unknown as Pick<WorkflowStep, 'do'>;
  const result = await runEconomicIndicatorSync(step, parent, scheduledTime, request, vi.fn(), { dmGroup: async () => child });
  expect(names).toEqual(['同步 Choice 经济指标']); expect(request).toHaveBeenCalledTimes(9);
  expect(result.status).toBe('partial'); expect(result.failures).toEqual(child.failures);
  expect(result.groups[1]).toEqual(child);
});
