import { test, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { runEconomicIndicatorSync, economicIndicatorRequests } from '../src/sync/economic-indicator-run.ts';
import { requestEconomicIndicatorData } from '../src/sync/economic-indicator-request.ts';
import { saveEdbResponse } from '../src/sync/edb-response-evidence.ts';
afterEach(() => vi.restoreAllMocks());
const scheduled = Date.parse('2026-10-12T16:00:00Z');
const specs = economicIndicatorRequests(scheduled).filter(s => s.source === 'choice-edb');
function harness({ archiveFails=false, archiveConflict=false, bad=false, recover=false, empty=false, invalidJson=false }={}) {
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const objects=[],saved=[],calls=[],attempts=[];
  const bucket={put:async(key,body,options)=>{ if(archiveFails)throw Error('secret-backend-error');if(archiveConflict)return null;objects.push({key,body:JSON.parse(body),options});return {}; }};
  const step={do:async(name,config,op)=>{for(let attempt=1;;attempt++){attempts.push({name,attempt});try{return await op({attempt});}catch(e){if(attempt>config.retries.limit)throw e;}}}};
  let failures=0;
  const request=(path,params,capture)=>requestEconomicIndicatorData({fetch:async()=>{
    calls.push({path,params:Object.fromEntries(params)});
    const fail=bad || (recover && failures++===0);
    if(invalidJson)return new Response('{bad-json');
    if(empty)return Response.json({function:'EDB',fields:['code','date','RESULT'],rows:[]});
    if(fail)return new Response('{"error":"original-http-error"}',{status:503});
    const rows=params.get('edbIds').split(',').flatMap(code=>[
      {code,date:'2026-10-10',RESULT:1.2147}, {code,date:'2026-10-11',RESULT:0},
      {code,date:'2026-10-12',RESULT:null}]);
    return Response.json({function:'EDB',fields:['code','date','RESULT'],rows});
  }},path,params,capture);
  const run=()=>runEconomicIndicatorSync(step,'workflow/safe',scheduled,request,async rows=>{saved.push(...rows);return {rowCount:rows.length,asOf:'2026-10-13'};},{archive:(spec,attempt,e)=>saveEdbResponse(bucket,'workflow/safe',scheduled,spec,attempt,e),dmGroup:async()=>({name:'DM',status:'complete',missing:[],failures:[],requests:[],rowCount:0,asOf:'',returnedCodes:[],pageCount:0})});
  return {run,objects,saved,calls,attempts};
}
test('archives each concurrent EDB response with its original dates/null/zero/missing keys and byte hashes',async()=>{
 const h=harness();const r=await h.run();expect(r.status).toBe('complete');expect(h.calls).toHaveLength(specs.length);expect(r.archivedResponses).toBe(specs.length);
 expect(new Set(h.objects.map(o=>o.key)).size).toBe(specs.length);
 for(const o of h.objects){const b=o.body,raw=JSON.parse(b.body);expect(b.version).toBe('edb-response-v1');expect(b.attempt).toBe(1);expect(b.request.parameters.edbIds).toBe(raw.rows.filter(x=>x.date==='2026-10-10').map(x=>x.code).join(','));expect(raw.rows[1]).toMatchObject({date:'2026-10-11',RESULT:0});expect(raw.rows[2].RESULT).toBeNull();expect(raw.rows[0]).not.toHaveProperty('PUBLISHDATE');expect(b.rawBodySha256).toBe(createHash('sha256').update(b.body).digest('hex'));expect(o.options.onlyIf.get('If-None-Match')).toBe('*');}
 expect(h.saved.some(x=>x.value===0 && x.observationDate==='2026-10-11')).toBe(true);expect(h.saved.some(x=>x.observationDate==='2026-10-12')).toBe(false);
});
test.each(['exception','conflict'])('all archive writes failing (%s) preserves payloads, source successes and request count without retries',async mode=>{
 const ok=harness();await ok.run();const h=harness(mode==='exception'?{archiveFails:true}:{archiveConflict:true});const r=await h.run();expect(h.objects).toHaveLength(0);expect(r.status).toBe('partial');expect(r.failures).toHaveLength(0);expect(r.archiveFailures).toHaveLength(specs.length);expect(h.calls).toHaveLength(specs.length);expect(h.saved).toEqual(ok.saved);expect(r.requests.every(x=>x.status==='complete')).toBe(true);expect(Math.max(...h.attempts.map(x=>x.attempt))).toBe(1);expect(JSON.stringify(r)).not.toContain('secret-backend-error');
});
test('HTTP failure remains the original source error when archive also fails and retains original retry policy',async()=>{
 const h=harness({archiveFails:true,bad:true});const r=await h.run();expect(h.calls).toHaveLength(specs.length*3);expect(r.failures).toHaveLength(specs.length);expect(r.failures[0].error.message).toContain('original-http-error');expect(r.failures[0].error.message).not.toContain('archive');expect(h.saved).toHaveLength(0);
});
test('true source retry produces separate attempt keys without cross-wiring concurrent sources',async()=>{
 const h=harness({recover:true});const r=await h.run();expect(r.status).toBe('complete');expect(h.calls).toHaveLength(specs.length*2);expect(new Set(h.objects.map(x=>x.key)).size).toBe(specs.length*2);expect(h.objects.some(x=>x.body.attempt===1 && x.body.status===503)).toBe(true);expect(h.objects.some(x=>x.body.attempt===2 && x.body.status===200)).toBe(true);
});
test('transport redaction preserves distinct received-byte and stored-body hashes',async()=>{
 const objects=[];const body='{"token":"sensitive-sentinel","rows":[{"date":"2026-10-11"}]}';
 await requestEconomicIndicatorData({fetch:async()=>new Response(body)},'/choice/edb',new URLSearchParams(),e=>saveEdbResponse({put:async(k,b)=>{objects.push(JSON.parse(b));return {};}},'id',scheduled,specs[0],1,e));
 expect(objects[0].body).toContain('"date":"2026-10-11"');expect(objects[0].body).not.toContain('RESULT');expect(objects[0].body).not.toContain('sensitive-sentinel');expect(objects[0].rawBodySha256).toBe(createHash('sha256').update(body).digest('hex'));expect(objects[0].storedBodySha256).not.toBe(objects[0].rawBodySha256);
});

test('invalid JSON retains its original decode error when archival is unavailable',async()=>{
 const errors=[];const capture=async evidence=>{try{throw Error('archive');}catch{errors.push(evidence.stage);}};
 await expect(requestEconomicIndicatorData({fetch:async()=>new Response('{bad-json')},'/choice/edb',new URLSearchParams(),capture)).rejects.toMatchObject({details:{stage:'decode_json'}});expect(errors).toEqual(['decode_json']);
});

test('empty successful EDB responses are archived without inventing rows or retrying',async()=>{
 const h=harness({empty:true});const r=await h.run();expect(r.status).toBe('complete');expect(r.archivedResponses).toBe(specs.length);expect(h.saved).toHaveLength(0);expect(h.calls).toHaveLength(specs.length);expect(h.objects.every(o=>JSON.parse(o.body.body).rows.length===0)).toBe(true);
});
test('JSON failure and R2 failure remain independent through the actual runner',async()=>{
 const h=harness({invalidJson:true,archiveFails:true});const r=await h.run();expect(h.calls).toHaveLength(specs.length*3);expect(r.failures).toHaveLength(specs.length);expect(r.failures.every(f=>f.error.message.includes('decode_json'))).toBe(true);expect(r.archiveFailures).toHaveLength(specs.length);
});
