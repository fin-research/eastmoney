import { expect, it, vi } from 'vitest';
vi.mock('../src/sync/economic-indicator-scheduled.ts',()=>({runEconomicIndicatorScheduledSync:vi.fn(async()=>undefined)}));
import { scheduledTasks } from '../src/scheduled-tasks';
import { runEconomicIndicatorScheduledSync } from '../src/sync/economic-indicator-scheduled';
it('validates method and minute timestamp before any dispatch',async()=>{
 vi.mocked(runEconomicIndicatorScheduledSync).mockClear();
 const env={} as Cloudflare.Env;
 for(const [path,method,status] of [['/other','POST',404],['/scheduled','GET',405],['/scheduled','POST',400],['/scheduled?scheduledTime=1','POST',400]] as const)
  expect((await scheduledTasks(new Request('https://internal'+path,{method}),env)).status).toBe(status);
 expect(runEconomicIndicatorScheduledSync).not.toHaveBeenCalled();
 const time=Date.parse('2026-10-09T16:00:00Z');
 expect((await scheduledTasks(new Request(`https://internal/scheduled?scheduledTime=${time}`,{method:'POST'}),env)).status).toBe(200);
 expect(runEconomicIndicatorScheduledSync).toHaveBeenCalledWith(env,time);
});
it('runner failures propagate rather than acknowledging success',async()=>{
 vi.mocked(runEconomicIndicatorScheduledSync).mockRejectedValueOnce(new Error('calendar unavailable'));
 await expect(scheduledTasks(new Request('https://internal/scheduled?scheduledTime='+Date.parse('2026-10-09T16:00:00Z'),{method:'POST'}),{} as Cloudflare.Env)).rejects.toThrow('calendar unavailable');
});
