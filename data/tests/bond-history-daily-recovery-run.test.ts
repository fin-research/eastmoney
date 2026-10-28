import { expect, it, vi } from 'vitest';
import type { CaptureDataResponse } from '../src/sync/css-response-evidence.ts';
import type { WorkflowStep } from 'cloudflare:workers';
const { sync }=vi.hoisted(()=>({sync:vi.fn()}));
vi.mock('../src/sync/bond-history-sync.ts',async original=>({...await original<typeof import('../src/sync/bond-history-sync.ts')>(),syncBondHistory:sync}));
import { runDailyBondRecovery } from '../src/sync/bond-history-daily-recovery.ts';
const time=1792944000000,id=`economic-indicator-sync-${time}`,child=`bond-history-recovery-${time}`;
function setup(objects:unknown[]=[]) {
 const output={scheduledTime:time,quant:{groups:[{name:'同步券商存续债估值',stored:0,
 failures:[{kind:'execution',error:JSON.stringify({path:'/choice/data-statistics',parameters:{funcName:'EM_CSS'},status:503,responseBody:JSON.stringify({error:{upstreamCode:10000009}})})}],
 missing:[{reason:'observation_absent',dates:['2026-10-23'],codes:['112840.SZ']},{reason:'observation_absent',dates:['2026-10-22'],codes:['112841.SZ']}]}]}};
 const results=new Map<string,unknown>();
 const step={sleepUntil:vi.fn(async(_name:string,date:Date)=>{
  if(date.getTime()<Date.now())throw Error('Cannot sleep until a time in the past');
 }),do:vi.fn(async(name:string,_options:unknown,fn:()=>Promise<unknown>)=>{
  if(!results.has(name))results.set(name,await fn());return results.get(name);
 })} as unknown as Pick<WorkflowStep,'do'|'sleepUntil'>;
 const list=vi.fn().mockResolvedValue({objects,truncated:false}),put=vi.fn().mockResolvedValue({key:'intent'});
 const env={ECONOMIC_INDICATOR_SYNC:{get:vi.fn().mockResolvedValue({status:async()=>({status:'complete',output})})},
 EASTMONEY:{list,put},HYPERDRIVE:{connectionString:'unused'}} as unknown as Cloudflare.Env;
 const request=vi.fn(async(_path:string,_parameters:URLSearchParams,capture?:CaptureDataResponse)=>{await capture?.({capturedAt:'2026-10-26T02:00Z',stage:'success',status:200,requestId:null,cfRay:null,complete:true,receivedBytes:2,retainedBytes:2,rawBodySha256:'a',retainedBodySha256:'a',body:'{}',redacted:false});return({function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-26',ENDDATE:'2026-11-01',AVAILABEDATA:1000000}]});});
 return {step,env,request,list,put};
}
it('limits each paid request to its original pair, preserves replay and shares original intent namespace',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(time+10*3600000);
 const s=setup();
 sync.mockImplementation(async(request: (p:string,q:URLSearchParams)=>Promise<unknown>,_db:unknown,_end:unknown,_dates:unknown,_quota:unknown,_codes:unknown,pairs:unknown)=>{
  expect(pairs).toEqual([{date:'2026-10-22',code:'112841.SZ'},{date:'2026-10-23',code:'112840.SZ'}]);
  await request('/choice/css',new URLSearchParams({codes:'112840.SZ',indicators:'YIELDCNBD,BONDBALANCE,MATUCNBD',options:'EndDate=2026-10-23,CredType=1'}));
  await expect(request('/choice/css',new URLSearchParams({codes:'112841.SZ',indicators:'YIELDCNBD,BONDBALANCE,MATUCNBD',options:'EndDate=2026-10-23,CredType=1'}))).rejects.toThrow('matrix');
  return {stored:1,failures:[],missing:[]};
 });
 await expect(runDailyBondRecovery(s.step,s.env,child,id,s.request)).resolves.toMatchObject({stored:1,scopePairs:2});
 await runDailyBondRecovery(s.step,s.env,child,id,s.request);
 expect(s.step.sleepUntil).not.toHaveBeenCalled();
 expect(s.request).toHaveBeenCalledTimes(2); // one quota and the one valid paid request
 expect(s.put.mock.calls[0]![0]).toContain(`/css-budget/${id}/history/`);
 expect(sync).toHaveBeenCalledTimes(1);
 vi.restoreAllMocks();
});
it('rejects an existing original paid intent or an expired window before any quota request',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(time+10*3600000);
 const s=setup([{key:'uncertain-paid-call'}]);
 await expect(runDailyBondRecovery(s.step,s.env,child,id,s.request)).rejects.toThrow('intent exists');
 expect(s.request).not.toHaveBeenCalled();
 vi.mocked(Date.now).mockReturnValue(time+21*3600000);
 const expired=setup();
 await expect(runDailyBondRecovery(expired.step,expired.env,child,id,expired.request)).rejects.toThrow('outside');
 expect(expired.request).not.toHaveBeenCalled();
 vi.restoreAllMocks();
});
it('persists a failed fresh preflight and performs no paid retry on replay',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(time+10*3600000);
 const s=setup();s.request.mockRejectedValue(Error('quota transport unavailable'));
 sync.mockImplementation(async(request: (p:string,q:URLSearchParams)=>Promise<unknown>)=>{
  await expect(request('/choice/data-statistics',new URLSearchParams({funcName:'EM_CSS'}))).rejects.toThrow('quota transport unavailable');
  return {stored:0,failures:[{source:'bond-history',error:'quota unavailable'}],missing:[]};
 });
 await expect(runDailyBondRecovery(s.step,s.env,child,id,s.request)).resolves.toMatchObject({status:'partial',stored:0});
 await runDailyBondRecovery(s.step,s.env,child,id,s.request);
 expect(s.request).toHaveBeenCalledTimes(1);
 expect(s.put).not.toHaveBeenCalled();
 vi.restoreAllMocks();
});
it('waits with bounded read-only status attempts before starting the fresh preflight',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(time+10*3600000);
 const s=setup();
 const terminal=await (await s.env.ECONOMIC_INDICATOR_SYNC.get(id)).status();
 const status=vi.fn().mockImplementationOnce(async()=>{
  expect(s.request).not.toHaveBeenCalled();return {status:'running'};
 }).mockResolvedValue(terminal);
 vi.mocked(s.env.ECONOMIC_INDICATOR_SYNC.get).mockResolvedValue({status} as never);
 const cached=new Map<string,unknown>();
 vi.mocked(s.step.do).mockImplementation((async(name:string,config:{retries:{limit:number}},operation:()=>Promise<unknown>)=>{
  if(cached.has(name))return cached.get(name);
  for(let attempt=0;;attempt++){
   try {const value=await operation();cached.set(name,value);return value;}
   catch(error){if(attempt>=config.retries.limit)throw error;}
  }
 }) as never);
 sync.mockResolvedValue({stored:0,failures:[],missing:[]});
 await runDailyBondRecovery(s.step,s.env,child,id,s.request);
 expect(status).toHaveBeenCalledTimes(2);
 expect(s.request).toHaveBeenCalledTimes(1);
 expect(s.request.mock.calls[0]![0]).toBe('/choice/data-statistics');
 vi.restoreAllMocks();
});
it('sleeps only before the recovery window and skips past-time sleeps after 09:00',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(time+8*3600000);
 const s=setup();
 vi.mocked(s.step.sleepUntil).mockImplementation((async(_name:string,date:Date)=>{
  expect(date.getTime()).toBe(time+9*3600000);
  clock.mockReturnValue(date.getTime());
 }) as never);
 sync.mockResolvedValue({stored:0,failures:[],missing:[]});
 await runDailyBondRecovery(s.step,s.env,child,id,s.request);
 expect(s.step.sleepUntil).toHaveBeenCalledTimes(1);
 expect(s.request).toHaveBeenCalledTimes(1);
 vi.restoreAllMocks();
});
