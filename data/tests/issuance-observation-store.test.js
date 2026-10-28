import {describe,it,expect,vi,afterEach} from 'vitest';
import {issuanceObservationRequests} from '../src/sync/issuance-observation-request.ts';
import {listObservationKeys,readObservation} from '../src/sync/issuance-observation-store.ts';
import {ISSUE_PRICING_FIELDS} from '../src/sync/quant-input-contract.ts';

import {observationBucket} from './helpers/issuance-observation-bucket.js';
const bond={code:'123456.SH',date:'2026-09-20'};
const query=()=>new URLSearchParams({codes:bond.code,indicators:ISSUE_PRICING_FIELDS.join(','),options:'Ispandas=1'});
const payload={function:'CSS',rows:[{code:bond.code,TENDERDATE:'2026/9/19',TENDERFINALCOUPON:2.1,ISSCORPCREDITRAT:'AAA',TENDERANNCDATE:'2026/9/1',UNREQUESTED:'ignored'}]};
afterEach(()=>vi.useRealTimers());
describe('bounded prospective issuance observations',()=>{
  it('records actual response time and finite raw fields, preserving source dates and unknown final publication time',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-04T03:04:05Z'));
    const bucket=observationBucket(),upstream=vi.fn(async()=>payload),observer=issuanceObservationRequests(bucket,'instance-1','2026-10-03',upstream);
    expect(await observer.forBonds([bond])('/choice/css',query())).toBe(payload);
    expect(upstream).toHaveBeenCalledOnce();
    const observation=await readObservation(bucket,'instance-1',observer.results[0].key);
    expect(observation.record).toMatchObject({scheduled_date:'2026-10-03',observed_at:'2026-10-04T03:04:05.000Z',final_coupon_published_at:null});
    expect(observation.content.payload.rows[0]).not.toHaveProperty('UNREQUESTED');
    expect(observation.content.payload.rows[0].TENDERANNCDATE).toBe('2026/9/1');
    expect(observation.record.quality.rows[0].quarantined).toBe(false);
  });
  it('same request/content reuses its original time; conflicting later content never replaces an archived observation',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-03T01:00:00Z'));
    const bucket=observationBucket();let current=payload;
    const observer=issuanceObservationRequests(bucket,'instance-2','2026-10-03',async()=>current);
    const request=observer.forBonds([bond]);await request('/choice/css',query());const first=observer.results[0];
    vi.setSystemTime(new Date('2026-10-04T01:00:00Z'));await request('/choice/css',query());
    expect(observer.results[1]).toMatchObject({key:first.key,observed_at:first.observed_at,status:'archived'});
    current={...payload,rows:[{...payload.rows[0],TENDERFINALCOUPON:2.2}]};
    expect(await request('/choice/css',query())).toBe(current);
    expect(observer.results[2]).toMatchObject({status:'failed'});
    expect((await readObservation(bucket,'instance-2',first.key)).content.payload.rows[0].TENDERFINALCOUPON).toBe(2.1);
    expect(await listObservationKeys(bucket,'instance-2')).toEqual([first.key]);
  });
  it('keeps null, absent, empty, missing-code and quarantine states distinct',async()=>{
    const bucket=observationBucket(),observer=issuanceObservationRequests(bucket,'instance-3','2026-10-03',async()=>({function:'CSS',rows:[
      {code:bond.code,TENDERDATE:'2026/9/30',TENDERFINALCOUPON:null,ISSCORPCREDITRAT:''},
    ]}));
    const absent={code:'123457.SH',date:bond.date};const q=query();q.set('codes',`${bond.code},${absent.code}`);
    await observer.forBonds([bond,absent])('/choice/css',q);
    const {record}=await readObservation(bucket,'instance-3',observer.results[0].key);
    expect(record.quality.missing_codes).toEqual([absent.code]);
    expect(record.quality.rows[0]).toMatchObject({quarantined:true,fields:expect.arrayContaining([
      {field:'TENDERFINALCOUPON',state:'null'},{field:'TENDERANNCDATE',state:'absent'},{field:'ISSCORPCREDITRAT',state:'empty'},
    ])});
  });
  it('archives empty success and no-data errors separately; failed requests have no value observation time',async()=>{
    const bucket=observationBucket(),observer=issuanceObservationRequests(bucket,'instance-4','2026-10-03',async()=>({function:'CSS',rows:[]}));
    await observer.forBonds([bond])('/choice/css',query());
    const success=await readObservation(bucket,'instance-4',observer.results[0].key);
    expect(success.content.kind).toBe('response');expect(success.record.observed_at).not.toBeNull();
    const error=new Error('10000009 no data');const failed=issuanceObservationRequests(bucket,'instance-5','2026-10-03',async()=>{throw error;});
    await expect(failed.forBonds([bond])('/choice/css',query())).rejects.toBe(error);
    const saved=await readObservation(bucket,'instance-5',failed.results[0].key);
    expect(saved.content).toEqual({kind:'no_data',error_code:10000009});expect(saved.record.observed_at).toBeNull();
  });
  it('an archive write failure returns the original response with no additional paid request',async()=>{
    const bucket=observationBucket();bucket.put.mockRejectedValue(new Error('R2 unavailable'));
    const upstream=vi.fn(async()=>payload),observer=issuanceObservationRequests(bucket,'instance-6','2026-10-03',upstream);
    expect(await observer.forBonds([bond])('/choice/css',query())).toBe(payload);
    expect(upstream).toHaveBeenCalledOnce();expect(observer.results[0].status).toBe('failed');
  });
  it('rejects tampered content and keys outside the specified original instance',async()=>{
    const bucket=observationBucket(),observer=issuanceObservationRequests(bucket,'instance-7','2026-10-03',async()=>payload);
    await observer.forBonds([bond])('/choice/css',query());const key=observer.results[0].key;
    const {record}=await readObservation(bucket,'instance-7',key);
    bucket.objects.set(record.content_key,'{}');
    await expect(readObservation(bucket,'instance-7',key)).rejects.toThrow('checksum');
    await expect(readObservation(bucket,'another-instance',key)).rejects.toThrow('outside');
  });
});
