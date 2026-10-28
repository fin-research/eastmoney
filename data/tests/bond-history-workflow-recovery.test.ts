import { expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('../src/sync/bond-history-sync.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sync/bond-history-sync.ts')>(), syncBondHistory: sync,
}));
import { runBondHistoryWorkflowRecovery, BOND_RECOVERY_INSTANCE, BOND_RECOVERY_ORIGINAL } from '../src/sync/bond-history-workflow-recovery.ts';

it('runs only the fixed history branch, persists its result and rejects a second instance', async () => {
  const results = new Map<string, unknown>();
  const step = { do: vi.fn(async (name: string, config: {retries: {limit:number}}, operation: () => Promise<unknown>) => {
    expect(config.retries.limit).toBe(0);
    if (!results.has(name)) results.set(name, await operation());
    return results.get(name);
  }) } as unknown as Pick<WorkflowStep,'do'>;
  const original = { scheduledTime:1792684800000, status:'partial', quant:{groups:[{name:'同步券商存续债估值',
    missing:[{reason:'observation_absent',dates:['2026-10-22'],codes:['112840.SZ']}]}]} };
  const get = vi.fn(async () => ({status: async () => ({status:'complete',output:original})}));
  const env = {ECONOMIC_INDICATOR_SYNC:{get},EASTMONEY:{},HYPERDRIVE:{connectionString:'unused'}} as unknown as Cloudflare.Env;
  const date = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const monday = new Date(date+'T00:00:00Z'); monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  const sunday = new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+6);
  const request = vi.fn(async () => ({function:'DATASTATISTICS', rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',
    STARTDATE:monday.toISOString().slice(0,10),ENDDATE:sunday.toISOString().slice(0,10),AVAILABEDATA:1000000}]}));
  sync.mockResolvedValue({stored:0,failures:[],missing:[]});
  const run = (id=BOND_RECOVERY_INSTANCE) => runBondHistoryWorkflowRecovery(step,env,id,BOND_RECOVERY_ORIGINAL,request);
  await expect(run()).resolves.toMatchObject({status:'complete',scopeCodes:1,maximumPoints:10000});
  await run();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]!.slice(2)).toEqual(['2026-10-23',['2026-10-22'],date,['112840.SZ']]);
  expect(request).toHaveBeenCalledTimes(1); // quota only: no unrelated source branch
  await expect(run('another-instance')).rejects.toThrow('Unapproved');
  expect(get).toHaveBeenCalledTimes(1);
});
