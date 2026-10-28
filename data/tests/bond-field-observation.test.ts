import {createHash} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {FIELD_OBSERVATION_INSTANCE as instance,FIELD_OBSERVATION_PLAN_KEY as planKey,
 parseFieldObservationPlan,runBondFieldObservation} from '../src/sync/bond-field-observation.ts';
import type {DataApiRequest} from '../src/sync/economic-indicator-sync.ts';
import type {WorkflowStep} from 'cloudflare:workers';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const codes=Array.from({length:83},(_,n)=>`${100000+n}.SH`);
const synthetic={version:1,instanceId:instance,operationDate:'2026-10-26',expiresAt:'2026-10-26T15:55:00.000Z',observationDate:'2026-10-23',codes,fields:['YIELDCNBD','MATUCNBD'],points:166,sharedReserve:100000,priorPlanSha256:'a'.repeat(64),priorIntents:codes.map(code=>({code,intents:[{key:`data-observations/css-budget/prior/history/${code}`,bodySha256:'b'.repeat(64)}]})),relatedWorkflowIds:Array.from({length:5},(_,i)=>`prior-${i}`),expectedObjects:Array.from({length:137},(_,i)=>({key:`data-observations/prior/${String(i).padStart(3,'0')}`,etag:`etag-${i}`,size:i})),quotaPeriod:{start:'2026-10-26',end:'2026-11-01'},mode:'observe-only',retries:0,split:0,databaseWrites:0};
const text=JSON.stringify(synthetic),approvedPlanSha=sha(text),plan=parseFieldObservationPlan(text,approvedPlanSha);
const quota={function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-26',ENDDATE:'2026-11-01',AVAILABEDATA:100166}]};
function harness(){
 const objects=new Map(plan.expectedObjects.map(o=>[o.key,{...o,body:'',customMetadata:{}}]));
 objects.set(planKey,{key:planKey,etag:'plan',size:Buffer.byteLength(text),body:text,customMetadata:{}});
 const results=new Map<string,unknown>();
 const step={do:vi.fn(async(name:string,config:unknown,operation:()=>Promise<unknown>)=>{
  expect(config).toMatchObject({retries:{limit:0}});
  if(!results.has(name))results.set(name,await operation());return results.get(name);
 })} as unknown as Pick<WorkflowStep,'do'>;
 const bucket={get:vi.fn(async(key:string)=>{const o=objects.get(key);return o?{...o,text:async()=>o.body}:null;}),
 list:vi.fn(async({prefix}:{prefix:string})=>({objects:[...objects.values()].filter(o=>o.key.startsWith(prefix)),truncated:false})),
 put:vi.fn(async(key:string,body:string,options:{onlyIf:Headers;customMetadata?:Record<string,string>})=>{
  expect(options.onlyIf.get('If-None-Match')).toBe('*');if(objects.has(key))return null;
  objects.set(key,{key,etag:sha(body),size:Buffer.byteLength(body),body,customMetadata:options.customMetadata??{}});return {key};
 })};
 const rows=plan.codes.map(code=>({code,date:'2026-10-23',chinabond_yield_pct:null,remaining_term_years:null,history_invalid_code:false,actual_issuance_status:'unknown'}));
 const query=vi.fn(async(sql:string)=>{if(sql.startsWith('SELECT'))return {rows};expect(/^(BEGIN.*READ ONLY|SET LOCAL|ROLLBACK)/.test(sql)).toBe(true);return {rows:[]};});
 const db=async<T>(operation:(c:never)=>Promise<T>)=>operation({query} as never);
 const status=vi.fn(async()=>({status:'complete'}));
 const request=vi.fn<DataApiRequest>(async(path,_params,capture)=>{
  const value=path.endsWith('data-statistics')?quota:{function:'CSS',rows:plan.codes.map(code=>({code,YIELDCNBD:null,MATUCNBD:null}))};
  const body=JSON.stringify(value);await capture?.({capturedAt:new Date().toISOString(),stage:'success',status:200,requestId:'source-id',cfRay:'ray',complete:true,receivedBytes:Buffer.byteLength(body),retainedBytes:Buffer.byteLength(body),rawBodySha256:sha(body),retainedBodySha256:sha(body),body,redacted:false});return value;
 });
 const run=()=>runBondFieldObservation(step,{EASTMONEY:bucket,ECONOMIC_INDICATOR_SYNC:{get:async()=>({status})}} as never,instance,planKey,request,db,approvedPlanSha);
 return {objects,results,step,bucket,rows,query,db,status,request,run};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T14:00:00Z'));vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('archives one 166-cell source-null observation with one quota, no database writes and no repeat on durable replay',async()=>{
 const h=harness();const result=await h.run();expect(result).toMatchObject({status:'observed-only',fields:166,databaseWrites:0});
 expect(h.request.mock.calls.map(c=>c[0])).toEqual(['/choice/data-statistics','/choice/css']);
 expect(h.request.mock.calls[1]![1].get('indicators')).toBe('YIELDCNBD,MATUCNBD');
 expect(h.request.mock.calls[1]![1].get('codes')!.split(',')).toHaveLength(83);
 const response=JSON.parse(h.objects.get(result.responseKey)!.body);expect(response.requestId).toBe('source-id');
 expect(JSON.parse(response.body).rows).toHaveLength(83);expect(response.body).toContain('"YIELDCNBD":null');
 expect(h.objects.get(result.responseKey)!.body).toContain('history-css-response-v1');
 await h.run();expect(h.request).toHaveBeenCalledTimes(2);
});
it.each(['filled','not-issued','duplicate'])('rejects changed exact scope %s before quota',async change=>{
 const h=harness();if(change==='filled')Object.assign(h.rows[0]!,{chinabond_yield_pct:1});
 if(change==='not-issued')h.rows[0]!.actual_issuance_status='not_issued';
 if(change==='duplicate')h.rows[0]!.code=h.rows[1]!.code;
 await expect(h.run()).rejects.toThrow('scope changed');expect(h.request).not.toHaveBeenCalled();
});
it('rejects incomplete listing, in-flight workflow and changed plan before quota',async()=>{
 for(const change of ['listing','workflow','plan']){
  const h=harness();if(change==='listing')h.bucket.list.mockResolvedValue({objects:[],truncated:true} as never);
  if(change==='workflow')h.status.mockResolvedValue({status:'running'});
  if(change==='plan')h.objects.get(planKey)!.body+=' ';
  await expect(h.run()).rejects.toThrow();expect(h.request).not.toHaveBeenCalled();
 }
});
it('persists the quota attempt before calling source and never repeats a failed quota after manual restart',async()=>{
 const h=harness();h.request.mockImplementation(async()=>{throw Error('quota transport unknown');});
 await expect(h.run()).rejects.toThrow('quota transport unknown');expect(h.request).toHaveBeenCalledTimes(1);
 h.results.delete('读取本流程共享CSS额度');
 await expect(h.run()).rejects.toThrow('refusing replay');expect(h.request).toHaveBeenCalledTimes(1);
});
it('stops on source error after archiving it, with no recursive call or replay',async()=>{
 const h=harness(),original=h.request.getMockImplementation()!;
 h.request.mockImplementation(async(path,params,capture)=>{const value=await original(path,params,capture);if(path.endsWith('/css'))throw Error('source 10003008');return value;});
 await expect(h.run()).rejects.toThrow('10003008');expect(h.request).toHaveBeenCalledTimes(2);
 await expect(h.run()).rejects.toThrow('inventory changed');expect(h.request).toHaveBeenCalledTimes(2);
 expect([...h.objects.keys()].filter(k=>k.includes('css-responses/'+instance))).toHaveLength(1);
});
it('retains paid intent and stops when response archival fails, without a second CSS or database update',async()=>{
 const h=harness(),put=h.bucket.put.getMockImplementation()!;
 h.bucket.put.mockImplementation(async(key,...args)=>{if(key.includes('css-responses/'+instance))throw Error('R2 failed');return put(key,...args);});
 await expect(h.run()).rejects.toThrow('response archive unavailable');expect(h.request).toHaveBeenCalledTimes(2);
 expect([...h.objects.keys()].filter(k=>k.includes('css-budget/'+instance))).toHaveLength(1);
 await expect(h.run()).rejects.toThrow();expect(h.request).toHaveBeenCalledTimes(2);
});
it('rechecks complete shared inventory after quota and rejects another execution before CSS',async()=>{
 const h=harness(),original=h.request.getMockImplementation()!;
 h.request.mockImplementation(async(...args)=>{const value=await original(...args);h.objects.set('data-observations/concurrent.json',{key:'data-observations/concurrent.json',etag:'new',size:0,body:'',customMetadata:{}});return value;});
 await expect(h.run()).rejects.toThrow('inventory changed');expect(h.request).toHaveBeenCalledTimes(1);
});
it('rejects a different instance or matrix before any remote operation',async()=>{
 const h=harness();expect(()=>parseFieldObservationPlan(text+' ',approvedPlanSha)).toThrow('Unapproved');
 await expect(runBondFieldObservation(h.step,{} as never,'other',planKey,h.request,h.db)).rejects.toThrow('Unapproved');
 expect(h.request).not.toHaveBeenCalled();expect(h.bucket.get).not.toHaveBeenCalled();
});

it('stops if archived quota bytes, hashes or completeness disagree, before paid intent',async()=>{
 for(const alteration of [{rawBodySha256:'0'.repeat(64)},{complete:false},{receivedBytes:1}]){
  const h=harness(),original=h.request.getMockImplementation()!;
  h.request.mockImplementation((path,parameters,capture)=>original(path,parameters,capture?evidence=>capture({...evidence,...alteration}):undefined));
  await expect(h.run()).rejects.toThrow('Quota response incomplete');expect(h.request).toHaveBeenCalledTimes(1);
  expect([...h.objects.keys()].filter(k=>k.includes('css-budget/'+instance))).toHaveLength(0);
 }
});
it('enforces the explicit new same-day stop time before any source request',async()=>{
 const h=harness();vi.setSystemTime(new Date('2026-10-26T15:55:00Z'));
 await expect(h.run()).rejects.toThrow('expired');expect(h.request).not.toHaveBeenCalled();
});
it('keeps durable preparation result small at the synthetic 83-code/137-object size',async()=>{
 const h=harness();await h.run();
 expect(Buffer.byteLength(JSON.stringify(h.results.get('核对冻结字段观察计划及只读缺口')))).toBeLessThan(1500);
 expect(plan.codes).toHaveLength(83);expect(plan.expectedObjects).toHaveLength(137);
});

it.each(['operation','quota'])('retains the intent and stops if %s expires during the final intent write',async boundary=>{
 const h=harness(),put=h.bucket.put.getMockImplementation()!;
 h.bucket.put.mockImplementation(async(key,...args)=>{
  const value=await put(key,...args);
  if(key.includes('css-budget/'+instance))vi.setSystemTime(new Date(boundary==='operation'?'2026-10-26T15:55:00Z':'2026-10-26T14:15:00.001Z'));
  return value;
 });
 await expect(h.run()).rejects.toThrow('response archive unavailable');expect(h.request).toHaveBeenCalledTimes(1);
 expect([...h.objects.keys()].filter(k=>k.includes('css-budget/'+instance))).toHaveLength(1);
 await expect(h.run()).rejects.toThrow();expect(h.request).toHaveBeenCalledTimes(1);
});

it('production default refuses a synthetic plan with zero source calls',async()=>{
 const h=harness();await expect(runBondFieldObservation(h.step,{EASTMONEY:h.bucket} as never,instance,planKey,h.request,h.db)).rejects.toThrow('SHA mismatch');
 expect(h.request).not.toHaveBeenCalled();
});
it('retains the quota marker and stops if its conditional write crosses the operation cutoff',async()=>{
 const h=harness(),put=h.bucket.put.getMockImplementation()!;
 h.bucket.put.mockImplementation(async(key,...args)=>{const value=await put(key,...args);if(key.endsWith('quota-attempt.json'))vi.setSystemTime(new Date('2026-10-26T15:55:00Z'));return value;});
 await expect(h.run()).rejects.toThrow('expired');expect(h.request).not.toHaveBeenCalled();
 expect([...h.objects.keys()].filter(k=>k.endsWith('quota-attempt.json'))).toHaveLength(1);
});
