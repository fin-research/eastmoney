import { test, expect, vi, afterEach } from 'vitest';
import { startEconomicIndicatorSyncWorkflow, runEconomicIndicatorScheduledSync } from '../src/sync/economic-indicator-scheduled.ts';
import { loadTradingDay } from '../src/trading-calendar.ts';
vi.mock('../src/trading-calendar.ts', () => ({ loadTradingDay: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
test('Cron uses the same instance id for duplicate delivery and supplies only its scheduled time', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const scheduledTime = Date.parse('2026-09-15T16:00:00Z');
  const id = `economic-indicator-sync-${scheduledTime}`;
  const binding = {
    create: vi.fn().mockResolvedValueOnce({ id }).mockRejectedValueOnce(new Error('already exists')),
    get: vi.fn(async () => ({ status: async () => ({ status: 'complete' }) })),
  };
  expect(await startEconomicIndicatorSyncWorkflow({ ECONOMIC_INDICATOR_SYNC: binding }, scheduledTime)).toBe(id);
  expect(await startEconomicIndicatorSyncWorkflow({ ECONOMIC_INDICATOR_SYNC: binding }, scheduledTime)).toBe(id);
  expect(binding.create.mock.calls[0][0].params).toEqual({ scheduledTime });
  expect(binding.get).toHaveBeenCalledExactlyOnceWith(id);
});
test.each(['2026-10-02', '2026-10-09'])('Shanghai trading-day midnight dispatch uses scheduled date: %s', async date => {
  vi.mocked(loadTradingDay).mockResolvedValue({ date, isTradingDay: true, previousTradingDate: '2026-09-30' });
  const create = vi.fn(async ({ id }) => ({ id }));
  const time = Date.parse(`${date}T00:00:00+08:00`);
  await runEconomicIndicatorScheduledSync({ ECONOMIC_INDICATOR_SYNC: { create } }, time);
  expect(loadTradingDay).toHaveBeenLastCalledWith(expect.anything(), date);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ params: { scheduledTime: time } }));
});
test.each(['2026-10-03', '2026-10-10'])('weekend midnight cannot create a workflow: %s', async date => {
  const create = vi.fn(); const previousCalls = loadTradingDay.mock.calls.length;
  await runEconomicIndicatorScheduledSync({ ECONOMIC_INDICATOR_SYNC: { create } }, Date.parse(`${date}T00:00:00+08:00`));
  expect(create).not.toHaveBeenCalled();
  expect(loadTradingDay.mock.calls.length).toBe(previousCalls);
});
test('holiday and unavailable calendar both prevent Workflow creation', async () => {
  const create = vi.fn(); const time = Date.parse('2026-10-01T00:00:00+08:00');
  vi.mocked(loadTradingDay).mockResolvedValue({ date: '2026-10-01', isTradingDay: false, previousTradingDate: '2026-09-30' });
  await runEconomicIndicatorScheduledSync({ ECONOMIC_INDICATOR_SYNC: { create } }, time);
  vi.mocked(loadTradingDay).mockRejectedValue(new Error('calendar unavailable'));
  await expect(runEconomicIndicatorScheduledSync({ ECONOMIC_INDICATOR_SYNC: { create } }, time)).rejects.toThrow('calendar unavailable');
  expect(create).not.toHaveBeenCalled();
});
test('different platform second offsets share the same scheduled minute ID and payload', async () => {
  vi.mocked(loadTradingDay).mockResolvedValue({date:'2026-10-09',isTradingDay:true,previousTradingDate:'2026-10-08'});
  const time=Date.parse('2026-10-08T16:00:00Z'),id=`economic-indicator-sync-${time}`;
  const create=vi.fn().mockResolvedValueOnce({id}).mockRejectedValueOnce(new Error('already exists'));
  const get=vi.fn(async()=>({status:async()=>({status:'complete'})}));
  const env={ECONOMIC_INDICATOR_SYNC:{create,get}};
  await runEconomicIndicatorScheduledSync(env,time+34_000);
  await runEconomicIndicatorScheduledSync(env,time+54_000);
  expect(create.mock.calls.map(([options])=>({id:options.id,params:options.params}))).toEqual([
    {id,params:{scheduledTime:time}},{id,params:{scheduledTime:time}},
  ]);
  expect(get).toHaveBeenCalledExactlyOnceWith(id);
});
