import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {issuanceObservationFixture} from './helpers/issuance-observation-fixture.ts';
import {readObservation,readLiveObservationManifest} from '../src/sync/issuance-observation-store.ts';

describe('Data-owned synthetic observation consumer contract',()=>{
  it('matches the reviewed fixture and validates every record through the owner implementation',async()=>{
    const fixture=issuanceObservationFixture();
    expect(JSON.parse(await readFile(new URL('./fixtures/issuance-observations-v1.json',import.meta.url),'utf8'))).toEqual(fixture);
    const bucket={get:async(key:string)=>{
      const object=fixture.objects.find(row=>row.key===key);
      return object?{size:new TextEncoder().encode(object.bytes).byteLength,text:async()=>object.bytes}:null;
    }};
    const manifest=await readLiveObservationManifest(bucket as never,fixture.instance);
    expect(manifest?.requests).toHaveLength(3);
    for(const request of manifest!.requests) {
      const observed=await readObservation(bucket as never,fixture.instance,request.key);
      expect(observed.record.observed_at).toBe('2026-09-30T01:00:00.000Z');
      expect(observed.record.final_coupon_published_at).toBeNull();
    }
  });
});
