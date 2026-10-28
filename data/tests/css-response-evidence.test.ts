import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import type { DataApiRequest } from '../src/sync/economic-indicator-sync.ts';
import { requestEconomicIndicatorData } from '../src/sync/economic-indicator-request.ts';
import { workflowCssBudget } from '../src/sync/workflow-css-budget.ts';
import { syncChoiceCssBatch } from '../src/sync/choice-css-batch.ts';
import { bondObservations } from '../src/sync/bond-history-sync.ts';
import { CssResponseArchiveError } from '../src/sync/css-response-evidence.ts';
const quota={function:'DATASTATISTICS',rows:[{FUNCENAME:'EM_CSS',SECUTYPE:'全品种',PERIOD:'W',STARTDATE:'2026-10-26',ENDDATE:'2026-11-01',AVAILABEDATA:1000000}]};
const params=new URLSearchParams({codes:'245867.SH',indicators:'YIELDCNBD,BONDBALANCE,MATUCNBD',options:'EndDate=2026-10-23,CredType=1'});
function setup(body:string,status=200,archiveFails=false) {
 const objects=new Map<string,{body:string;points?:string}>(),order:string[]=[];
 const bucket={list:vi.fn(async({prefix}:{prefix:string})=>({objects:[...objects].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,customMetadata:{points:v.points}})),truncated:false})),
 put:vi.fn(async(key:string,value:string,options:{customMetadata?:{points?:string}})=>{order.push(key.includes('css-responses')?'archive':'intent');if(archiveFails&&key.includes('css-responses'))throw Error('10003008 fake archive error');if(objects.has(key))return null;objects.set(key,{body:value,points:options.customMetadata?.points});return{key};})} as unknown as Pick<R2Bucket,'list'|'put'>;
 const fetch=vi.fn(async()=>{order.push('fetch');return new Response(body,{status,headers:{'X-Request-Id':'source-1','CF-Ray':'edge-ray'}});});
 const request:DataApiRequest=async(path,p,capture)=>path.endsWith('data-statistics')?quota:requestEconomicIndicatorData({fetch},path,p,capture);
 const step={do:vi.fn(async(_n:unknown,_o:unknown,f:()=>Promise<unknown>)=>f())} as unknown as Pick<WorkflowStep,'do'>;
 const client=()=>workflowCssBudget(step,bucket,'test-run',request,'2026-10-26',{history:100},()=>Date.parse('2026-10-26T10:00Z'))('history');
 return{objects,order,bucket,fetch,client};
}
it('archives original null/omitted fields before returning rows and hashes original bytes separately from stored text',async()=>{
 const raw='{ "function":"CSS", "rows":[{"code":"245867.SH","YIELDCNBD":null,"BONDBALANCE":200,"token":"secret"}] }';
 const h=setup(raw);const result=await h.client()('/choice/css',params);h.order.push('apply');
 expect(bondObservations(result,['245867.SH'])).toEqual([{code:'245867.SH',yield:null,balance:200,term:null}]);
 expect(h.order).toEqual(['intent','fetch','archive','apply']);expect(h.fetch).toHaveBeenCalledTimes(1);
 const [key,v]=[...h.objects].find(([k])=>k.includes('css-responses'))!;const e=JSON.parse(v.body);
 expect(e).toMatchObject({requestId:'source-1',cfRay:'edge-ray',complete:true,stage:'success',redacted:true,intentKey:key.replace('css-responses','css-budget'),rawBodySha256:createHash('sha256').update(raw).digest('hex')});
 expect(e.body).toContain('"YIELDCNBD":null');expect(e.body).not.toContain('MATUCNBD');expect(e.body).not.toContain('secret');
 expect(e.storedBodySha256).not.toBe(e.rawBodySha256);
});
it('archives the same HTTP error body before invalid-code exclusion without a second fetch',async()=>{
 const raw=JSON.stringify({error:{upstreamCode:10003008}}),h=setup(raw,503),apply=vi.fn(),exclude=vi.fn();
 await syncChoiceCssBatch(h.client(),['245867.SH'],params.get('indicators')!.split(','),params.get('options')!,apply,exclude);
 expect(h.fetch).toHaveBeenCalledTimes(1);expect(apply).not.toHaveBeenCalled();expect(exclude).toHaveBeenCalledWith('245867.SH');
 expect(JSON.parse([...h.objects].find(([k])=>k.includes('css-responses'))![1].body)).toMatchObject({stage:'http_response',status:503,body:raw});
});
it.each([200,503])('stops archive failure before apply/exclusion and never replays paid status %s',async status=>{
 const h=setup(status===200?'{"function":"CSS","rows":[]}':'{"error":{"upstreamCode":10003008}}',status,true),apply=vi.fn(),exclude=vi.fn();
 const run=()=>syncChoiceCssBatch(h.client(),['245867.SH'],params.get('indicators')!.split(','),params.get('options')!,apply,exclude);
 await expect(run()).rejects.toBeInstanceOf(CssResponseArchiveError);
 await expect(run()).rejects.toThrow('intent already exists');
 expect(apply).not.toHaveBeenCalled();expect(exclude).not.toHaveBeenCalled();expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('retains bounded incomplete evidence and no full-body hash for an oversized response',async()=>{
 const h=setup('x'.repeat(8*1024*1024+2));await expect(h.client()('/choice/css',params)).rejects.toThrow('response_size');
 const e=JSON.parse([...h.objects].find(([k])=>k.includes('css-responses'))![1].body);
 expect(e).toMatchObject({complete:false,rawBodySha256:null,retainedBytes:8*1024*1024+1});expect(e.retainedBodySha256).toMatch(/^[a-f0-9]{64}$/);expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('does not write a history row or invalidate a bond when response archiving fails',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const {readdir,readFile}=await import('node:fs/promises');
 const {syncBondHistory}=await import('../src/sync/bond-history-sync.ts');
 const engine=new PGlite();const dir=new URL('../edb-migrations/',import.meta.url);
 try {
  for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await engine.exec(await readFile(new URL(file,dir),'utf8'));
  await engine.exec("INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES('245867.SH','2026-01-01','测试证券')");
  const h=setup('{"function":"CSS","rows":[{"code":"245867.SH","YIELDCNBD":2,"BONDBALANCE":200,"MATUCNBD":3}]}',200,true);
  const client={query:async(sql:string,params?:unknown[])=>{const r=await engine.query(sql,params);return{...r,rowCount:r.affectedRows};}};
  const result=await syncBondHistory(h.client(),async op=>op(client as never),'2026-10-26',['2026-10-23']);
  expect(result.stored).toBe(0);expect(result.failures).toContainEqual(expect.objectContaining({kind:'execution',error:expect.stringContaining('CSS response archive unavailable')}));
  expect((await engine.query('SELECT * FROM public.bond_history')).rows).toEqual([]);
  expect((await engine.query('SELECT history_invalid_code FROM public.bond_issuance')).rows).toEqual([{history_invalid_code:false}]);
  expect(h.fetch).toHaveBeenCalledTimes(1);
 }finally{await engine.close();}
});
it('persists a failed fetch as unknown response and rejects a second paid execution',async()=>{
 const h=setup('');h.fetch.mockRejectedValue(Error('network unavailable'));
 await expect(h.client()('/choice/css',params)).rejects.toThrow('network unavailable');
 const e=JSON.parse([...h.objects].find(([k])=>k.includes('css-responses'))![1].body);
 expect(e).toMatchObject({stage:'fetch',status:null,complete:false,rawBodySha256:null,body:null});
 await expect(h.client()('/choice/css',params)).rejects.toThrow('intent already exists');expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('blocks unarchived source errors if an intermediate transport drops the evidence callback',async()=>{
 const h=setup('');const broken:DataApiRequest=async(path)=>{if(path.endsWith('data-statistics'))return quota;throw Error('10003008');};
 const step={do:async(_n:unknown,_o:unknown,f:()=>Promise<unknown>)=>f()} as unknown as Pick<WorkflowStep,'do'>;
 const client=workflowCssBudget(step,h.bucket,'broken-transport',broken,'2026-10-26',{history:100})('history');
 const apply=vi.fn(),exclude=vi.fn();
 await expect(syncChoiceCssBatch(client,['245867.SH'],params.get('indicators')!.split(','),params.get('options')!,apply,exclude)).rejects.toBeInstanceOf(CssResponseArchiveError);
 expect(exclude).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});

it.each(['truncated','interrupted'])('never isolates or recursively charges from an incomplete %s error containing 10003008',async mode=>{
 const raw='{"error":{"upstreamCode":10003008}}',h=setup(raw+' '.repeat(24001),503);
 if(mode==='interrupted')h.fetch.mockImplementation(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(raw));},pull(c){c.error(Error('read interrupted'));}}),{status:503}));
 const apply=vi.fn(),exclude=vi.fn();
 await expect(syncChoiceCssBatch(h.client(),['245867.SH','245673.SH'],params.get('indicators')!.split(','),params.get('options')!,apply,exclude)).rejects.toThrow(mode==='truncated'?'responseTruncated':'read_response');
 expect(apply).not.toHaveBeenCalled();expect(exclude).not.toHaveBeenCalled();expect(h.fetch).toHaveBeenCalledTimes(1);
 const e=JSON.parse([...h.objects].find(([k])=>k.includes('css-responses'))![1].body);
 expect(e).toMatchObject({complete:false,rawBodySha256:null,stage:mode==='truncated'?'http_response':'read_response'});expect(e.body).toContain('10003008');
});

it.each(['truncated','readError'])('does not isolate from a complete Data envelope carrying an incomplete upstream %s body',async reason=>{
 const h=setup(JSON.stringify({error:{upstreamCode:10003008,upstreamResponse:{[reason]:reason==='truncated'?true:'read failed',body:'{"error":{"upstreamCode":10003008}}'}}}),503);
 const apply=vi.fn(),exclude=vi.fn();
 await expect(syncChoiceCssBatch(h.client(),['245867.SH','245673.SH'],params.get('indicators')!.split(','),params.get('options')!,apply,exclude)).rejects.toThrow('10003008');
 expect(exclude).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();expect(h.fetch).toHaveBeenCalledTimes(1);
});
