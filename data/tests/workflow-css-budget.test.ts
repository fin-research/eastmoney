import { expect, it, vi } from 'vitest';
import type { CaptureDataResponse } from '../src/sync/css-response-evidence.ts';
import { workflowCssBudget, WORKFLOW_CSS_BUDGET } from '../src/sync/workflow-css-budget.ts';
import { bondRecoveryCodes, restrictBondRecovery } from '../src/sync/bond-history-workflow-recovery.ts';

const params = (code='112840.SZ',fields='YIELDCNBD') => new URLSearchParams({codes:code,indicators:fields,options:'EndDate=2026-10-22,CredType=1'});
function harness() {
  const intents = new Map<string,{points:string}>();
  const bucket = {list:vi.fn(async ({prefix}:{prefix:string})=>({objects:[...intents].filter(([key])=>key.startsWith(prefix))
    .map(([key,customMetadata])=>({key,customMetadata})),truncated:false})),
  put:vi.fn(async(key:string,_body:string,options:{customMetadata:{points:string}})=>{
    if(intents.has(key))return null;intents.set(key,options.customMetadata);return {key};
  })} as unknown as Pick<R2Bucket,'list'|'put'>;
  return {bucket,intents};
}
const now = () => Date.parse('2026-10-23T01:00:00Z');
it('keeps the code-declared group caps and never reads Choice quota', async () => {
  expect(Object.values(WORKFLOW_CSS_BUDGET).reduce((a,b)=>a+b,0)).toBe(167544);
  const h=harness(),request=vi.fn(async(path:string,_p:URLSearchParams,capture?:CaptureDataResponse)=>{
    await capture?.({capturedAt:'2026-10-23T01:00:00Z',stage:'success',status:200,requestId:null,cfRay:null,complete:true,receivedBytes:2,retainedBytes:2,rawBodySha256:'a',retainedBodySha256:'a',body:'{}',redacted:false});
    return {function:'CSS',rows:[]};});
  const clients=workflowCssBudget(h.bucket,'instance-one',request,{equity:2,history:3},now);
  await clients('equity')('/choice/css',params());await clients('history')('/choice/css',params());
  expect(request.mock.calls.map(([path])=>path)).toEqual(['/choice/css','/choice/css']);
  expect([...h.intents.keys()].filter(k=>k.includes('css-budget'))).toHaveLength(2);
});
it('refuses to read Choice quota', async () => {
  const h=harness(),request=vi.fn(async()=>({}));
  await expect(workflowCssBudget(h.bucket,'instance-one',request,{history:3},now)('history')('/choice/data-statistics',new URLSearchParams({funcName:'EM_CSS'}))).rejects.toThrow('never read Choice quota');
  expect(request).not.toHaveBeenCalled();
});
it('passes non-CSS paths through without an intent', async () => {
  const h=harness(),request=vi.fn(async()=>({ok:true}));
  await workflowCssBudget(h.bucket,'instance-one',request,{history:3},now)('history')('/choice/ctr',new URLSearchParams());
  expect(request).toHaveBeenCalledTimes(1);expect(h.intents.size).toBe(0);
});
it('reconstructs spent points after replay and never repeats failed/unknown paid intents', async () => {
  const h=harness();
  const request=vi.fn(async()=>{throw Error('unknown paid execution');});
  const create=()=>workflowCssBudget(h.bucket,'instance-one',request,{history:3},now)('history');
  await expect(create()('/choice/css',params())).rejects.toThrow('response archive unavailable');
  await expect(create()('/choice/css',params())).rejects.toThrow('intent already exists');
  await expect(create()('/choice/css',params('151105.SH','YIELDCNBD,MATUCNBD,BONDBALANCE'))).rejects.toThrow('budget exhausted');
  expect(request).toHaveBeenCalledTimes(1);
});
it('recovers only the original absent October22 bond scope and blocks every other paid source/date/field', async () => {
  const codes=bondRecoveryCodes({scheduledTime:1792684800000,status:'partial',quant:{groups:[{name:'同步券商存续债估值',missing:[
    {reason:'observation_absent',dates:['2026-10-22'],codes:['112840.SZ','242690X2.SH','245230X.SH']},
    {reason:'stored_fields_incomplete',dates:['2026-10-22'],codes:['151105.SH']},
    {reason:'observation_absent',dates:['2026-10-21'],codes:['151106.SH']},
  ]}]}});expect(codes).toEqual(['112840.SZ','242690X2.SH','245230X.SH']);
  const request=vi.fn(async()=>({})),client=restrictBondRecovery(request,codes);
  await client('/choice/css',params('112840.SZ','YIELDCNBD,BONDBALANCE,MATUCNBD'));
  await expect(client('/choice/css',params('151105.SH','YIELDCNBD,BONDBALANCE,MATUCNBD'))).rejects.toThrow('scope');
  await expect(client('/choice/css',params())).rejects.toThrow('scope');
  await expect(client('/choice/ctr',new URLSearchParams())).rejects.toThrow('scope');
  await expect(client('/choice/data-statistics',new URLSearchParams({funcName:'EM_CSS'}))).rejects.toThrow('scope');
  const wrongDate=params('112840.SZ','YIELDCNBD,BONDBALANCE,MATUCNBD');wrongDate.set('options','EndDate=2026-10-21,CredType=1');
  await expect(client('/choice/css',wrongDate)).rejects.toThrow('scope');expect(request).toHaveBeenCalledTimes(1);
});
it('never sends CSS if persisting its paid intent fails', async () => {
  const h=harness(),request=vi.fn(async()=>({}));
  vi.mocked(h.bucket.put).mockRejectedValue(Error('R2 unavailable'));
  const client=workflowCssBudget(h.bucket,'instance-one',request,{history:3})('history');
  await expect(client('/choice/css',params())).rejects.toThrow('R2 unavailable');
  expect(request).not.toHaveBeenCalled();
});
it('counts every intent page and refuses a truncated page without a continuation cursor', async () => {
  const h=harness(),request=vi.fn(async()=>({}));
  vi.mocked(h.bucket.list).mockResolvedValueOnce({objects:[{key:'old',customMetadata:{points:'2'}}],truncated:true,cursor:'next'} as never)
    .mockResolvedValueOnce({objects:[{key:'old2',customMetadata:{points:'1'}}],truncated:false} as never);
  const client=workflowCssBudget(h.bucket,'instance-one',request,{history:3})('history');
  await expect(client('/choice/css',params())).rejects.toThrow('budget exhausted');
  expect(h.bucket.list).toHaveBeenCalledTimes(2);expect(request).not.toHaveBeenCalled();
  const h2=harness();vi.mocked(h2.bucket.list).mockResolvedValue({objects:[],truncated:true} as never);
  const c2=workflowCssBudget(h2.bucket,'instance-two',request,{history:3})('history');
  await expect(c2('/choice/css',params())).rejects.toThrow('Incomplete persisted');
  expect(h2.bucket.put).not.toHaveBeenCalled();
});
