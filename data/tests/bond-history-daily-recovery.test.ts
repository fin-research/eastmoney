import { expect, it, vi } from 'vitest';
import { dailyRecoveryIdentity, dailyRecoveryPairs, quotaUnavailable, startDailyBondRecovery } from '../src/sync/bond-history-daily-recovery.ts';
const id = 'economic-indicator-sync-1792944000000';
const quotaError = JSON.stringify({ path:'/choice/data-statistics',parameters:{funcName:'EM_CSS'},status:503,
  responseBody:JSON.stringify({error:{upstreamCode:10000009}}) });
const original = () => ({scheduledTime:1792944000000,quant:{groups:[{name:'同步券商存续债估值',stored:0,
  failures:[{kind:'execution',error:quotaError}],missing:[
    {reason:'observation_absent',dates:['2026-10-23'],codes:['112840.SZ']},
    {reason:'observation_absent',dates:['2026-10-22'],codes:['112841.SZ']},
    {reason:'stored_fields_incomplete',dates:['2026-10-23'],codes:['112842.SZ']},
  ]}]}});
it('binds Shanghai midnight identity and retains exact date/code matrix',()=>{
  expect(dailyRecoveryIdentity(id)).toEqual({time:1792944000000,date:'2026-10-26',id:'bond-history-recovery-1792944000000',
    opensAt:1792976400000,closesAt:1793019600000});
  expect(dailyRecoveryPairs(original(),id)).toEqual([{date:'2026-10-22',code:'112841.SZ'},{date:'2026-10-23',code:'112840.SZ'}]);
  expect(()=>dailyRecoveryIdentity('economic-indicator-sync-1792944060000')).toThrow('midnight');
  const ambiguous=original();ambiguous.quant.groups[0]!.missing[0]!.dates=['2026-10-22','2026-10-23'];
  expect(()=>dailyRecoveryPairs(ambiguous,id)).toThrow('Ambiguous');
});
it('requires the persisted structured quota failure, not zero writes, prose or a data-source no-data error',()=>{
  expect(quotaUnavailable(original())).toBe(true);
  for(const error of ['quota 10000009',JSON.stringify({path:'/choice/css',parameters:{funcName:'EM_CSS'},status:503,responseBody:'{}'}),
    quotaError.replace('EM_CSS','EM_CSD'),quotaError.replace('10000009','10001003')]){
    const input=original();input.quant.groups[0]!.failures[0]!.error=error;
    expect(quotaUnavailable(input)).toBe(false);
  }
  const written=original();written.quant.groups[0]!.stored=1;
  expect(quotaUnavailable(written)).toBe(false);
});
it('uses one deterministic child and does not dispatch an unrelated or successful run',async()=>{
  const create=vi.fn().mockRejectedValue(Error('exists')),status=vi.fn().mockResolvedValue({status:'running'});
  const env={ECONOMIC_INDICATOR_SYNC:{create,get:vi.fn().mockResolvedValue({status})}} as unknown as Cloudflare.Env;
  expect(await startDailyBondRecovery(env,id,original())).toBe('bond-history-recovery-1792944000000');
  expect(create.mock.calls[0]![0].id).toBe('bond-history-recovery-1792944000000');
  const complete=original();complete.quant.groups[0]!.failures=[];
  expect(await startDailyBondRecovery(env,id,complete)).toBeNull();
  expect(await startDailyBondRecovery(env,'manual-run',original())).toBeNull();
  expect(create).toHaveBeenCalledTimes(1);
});
