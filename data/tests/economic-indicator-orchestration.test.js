import { test, expect, vi, afterEach } from 'vitest';
const { indicators, quant, replay } = vi.hoisted(() => ({ indicators: vi.fn(), quant: vi.fn(), replay: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class { constructor(_ctx, env) { this.env = env; } } }));
vi.mock('../src/app.ts', () => ({ handleRequest: vi.fn() }));
vi.mock('../src/sync/economic-indicator-run.ts', () => ({ runEconomicIndicatorSync: indicators }));
vi.mock('../src/sync/issuance-observation-replay.ts', () => ({ replayIssuanceObservations: replay }));
vi.mock('../src/sync/quant-input-run.ts', () => ({ runQuantInputSync: quant }));
vi.mock('../src/sync/postgres.ts', () => ({ withPostgres: async (_url, _name, operation) => operation({}) }));
import { DmFundingSyncWorkflow, EconomicIndicatorSyncWorkflow } from '../src/sync/economic-indicator-workflow.ts';
import { dmFundingChildId } from '../src/sync/dm-funding-child.ts';
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

function fixture() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const workflow = new EconomicIndicatorSyncWorkflow({}, { HYPERDRIVE: { connectionString: 'test' } });
  const event = { instanceId: 'test', payload: { scheduledTime: Date.parse('2026-09-17T16:00:00Z') } };
  const summaries = [];
  const step = { do: async (name, operation) => { const result = await operation(); summaries.push({ name, result }); return result; } };
  return { run: () => workflow.run(event, step), summaries };
}

test.each([
  ['complete', 'complete', 'complete'], ['complete', 'partial', 'partial'], ['partial', 'complete', 'partial'],
])('joins %s indicators and %s quant as %s only after both parallel branches settle', async (indicatorStatus, quantStatus, status) => {
  const h = fixture(), hold = Promise.withResolvers();
  indicators.mockReturnValue(hold.promise);
  quant.mockResolvedValue({ status: quantStatus, stored: 2, failures: [], groups: [] });
  const pending = h.run();
  expect(indicators).toHaveBeenCalledOnce(); expect(quant).toHaveBeenCalledOnce();
  hold.resolve({ status: indicatorStatus, groups: [] });
  expect((await pending).status).toBe(status);
  expect(h.summaries).toHaveLength(1);
  expect(h.summaries[0]).toMatchObject({ name: '汇总同步结果', result: { status } });
});

test('all indicator sources failing preserves the quant summary before failing the workflow', async () => {
  const h = fixture();
  indicators.mockResolvedValue({ status: 'failed', groups: [], failures: [{ error: 'unavailable' }] });
  quant.mockResolvedValue({ status: 'complete', stored: 2, failures: [], groups: [] });
  await expect(h.run()).rejects.toThrow('"status":"failed"');
  expect(h.summaries[0].result.quant.stored).toBe(2);
});

test('summary step failure cannot be reported as successful completion', async () => {
  const h = fixture();
  indicators.mockResolvedValue({ status: 'complete', groups: [] });
  quant.mockResolvedValue({ status: 'complete', stored: 2, failures: [], groups: [] });
  vi.spyOn(console,'log').mockImplementation(() => { throw new Error('summary unavailable'); });
  await expect(h.run()).rejects.toThrow('summary unavailable');
  expect(h.summaries).toHaveLength(0);
});


test('explicit archive replay branches before every normal paid, quota and calendar runner', async () => {
  indicators.mockImplementation(() => { throw new Error('Normal EDB upstream forbidden during replay'); });
  quant.mockImplementation(() => { throw new Error('Normal Quant or quota upstream forbidden during replay'); });
  replay.mockResolvedValue({ status: 'complete', paid_requests: 0 });
  const env = { HYPERDRIVE: { connectionString: 'test' }, EASTMONEY: {} };
  const workflow = new EconomicIndicatorSyncWorkflow({}, env);
  const steps = [];
  const result = await workflow.run({ instanceId: 'replay-1', payload: { issuanceReplayOf: 'original-1' } },
    { do: async (name, config, operation) => { steps.push({name,config}); return operation(); } });
  expect(result).toEqual({ status: 'complete', paid_requests: 0 });
  expect(indicators).not.toHaveBeenCalled(); expect(quant).not.toHaveBeenCalled();
  expect(replay).toHaveBeenCalledWith(env.EASTMONEY, expect.any(Function), 'original-1', 'replay-1');
  expect(steps).toHaveLength(1); expect(steps[0].config.retries.limit).toBe(0);
});

test('workflow passes the Choice completion barrier to Quant without waiting for DM completion', async () => {
  const h = fixture(), dm = Promise.withResolvers(), quantDone = Promise.withResolvers();
  indicators.mockImplementation(async (...args) => {
    args[5].choiceSettled();
    await dm.promise;
    return { status: 'complete', groups: [] };
  });
  quant.mockImplementation(async (...args) => {
    await args[5]; quantDone.resolve();
    return { status: 'complete', groups: [] };
  });
  const pending = h.run();
  await quantDone.promise;
  expect(h.summaries).toHaveLength(0);
  dm.resolve();
  expect((await pending).status).toBe('complete');
});

test.each(['bondHistoryRecoveryOf','issuanceReplayOf'])('rejects observation combined with %s before every runner',async mode=>{
 const workflow=new EconomicIndicatorSyncWorkflow({},{});
 await expect(workflow.run({instanceId:'test',payload:{bondFieldObservationPlan:'plan',[mode]:'original'}},{})).rejects.toThrow('Conflicting');
 expect(indicators).not.toHaveBeenCalled();expect(quant).not.toHaveBeenCalled();expect(replay).not.toHaveBeenCalled();
});

test('DM child notifies only after its committed group returns, keeping notification retries outside the data run', async () => {
  const parentInstanceId = 'parent-event-test', scheduledTime = 1;
  const group = { name: '同步 DM 资金面', status: 'complete', rowCount: 6 };
  const sendEvent = vi.fn().mockRejectedValueOnce(new Error('notification unavailable')).mockResolvedValue(undefined);
  const get = vi.fn(async () => ({ sendEvent }));
  const child = new DmFundingSyncWorkflow({}, { ECONOMIC_INDICATOR_SYNC: { get }, HYPERDRIVE: { connectionString: 'test' } });
  indicators.mockResolvedValue({ groups: [group] });
  const step = { do: async (_name, config, operation) => {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); } catch (error) { if (attempt >= config.retries.limit) throw error; }
    }
  } };
  const output = await child.run({ instanceId: dmFundingChildId(parentInstanceId),
    payload: { parentInstanceId, scheduledTime, notifyParent: true } }, step);
  expect(output).toEqual({ parentInstanceId, scheduledTime, group });
  expect(indicators).toHaveBeenCalledOnce();
  expect(sendEvent).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledWith(parentInstanceId);
});
