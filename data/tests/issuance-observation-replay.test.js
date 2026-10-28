import {it,expect,vi} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {observationBucket} from './helpers/issuance-observation-bucket.js';
import {issuanceObservationRequests} from '../src/sync/issuance-observation-request.ts';
import {replayIssuanceObservations} from '../src/sync/issuance-observation-replay.ts';
import {listObservationKeys,readObservation,saveLiveObservationManifest} from '../src/sync/issuance-observation-store.ts';
import {syncBondPlacement} from '../src/sync/bond-placement-sync.ts';
import {fetchIssuePricing,persistPricingRows} from '../src/sync/quant-pricing.ts';
import {ISSUE_PRICING_FIELDS} from '../src/sync/quant-input-contract.ts';
import {quantMarketRequests} from '../src/sync/quant-market-sync.ts';

async function database(){
 const engine=new PGlite(),directory=new URL('../edb-migrations/',import.meta.url);
 for(const name of(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await engine.exec(await readFile(new URL(name,directory),'utf8'));
 const client={query:async(...args)=>{const r=await engine.query(...args);return{...r,rowCount:r.affectedRows??r.rows.length};}};
 return {engine,client,db:operation=>operation(client)};
}
async function seal(bucket,instance){
 const keys=await listObservationKeys(bucket,instance);
 const observations=await Promise.all(keys.map(k=>readObservation(bucket,instance,k)));
 await saveLiveObservationManifest(bucket,instance,observations.map(o=>({key:o.key,source:o.record.request.source,status:'archived',outcome:o.content.kind})));
}
const bond={code:'123456.SH',date:'2026-09-20'};
const pricingQuery=()=>new URLSearchParams({codes:bond.code,indicators:ISSUE_PRICING_FIELDS.join(','),options:'Ispandas=1'});
const pricingPayload={function:'CSS',rows:[{code:bond.code,TENDERDATE:'2026/9/19',TENDERFINALCOUPON:2.1,ISSCORPCREDITRAT:'AAA',TENDERANNCDATE:'2026/9/1'}]};

it('recovers an archived response after database failure with no upstream or quota requests',async()=>{
 const {engine,client,db}=await database(),bucket=observationBucket();let calls=0;
 const upstream=vi.fn(async()=>{calls++;if(calls>1)throw Error('Any replay upstream call is forbidden');return pricingPayload;});
 const observer=issuanceObservationRequests(bucket,'original-db-failed','2026-10-03',upstream);
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES($1,$2,'测试证券')`,[bond.code,bond.date]);
  const {rows}=await fetchIssuePricing(observer.forBonds([bond]),[bond]);
  await expect(persistPricingRows({query:async()=>{throw Error('database unavailable');}},[bond],rows)).rejects.toThrow('database unavailable');
  expect((await engine.query('SELECT final_coupon_pct FROM public.bond_issuance')).rows[0].final_coupon_pct).toBeNull();
  await seal(bucket,'original-db-failed');
  const result=await replayIssuanceObservations(bucket,db,'original-db-failed','replay-db-failed');
  expect(result).toMatchObject({status:'complete',paid_requests:0});expect(upstream).toHaveBeenCalledOnce();
  expect((await engine.query('SELECT final_coupon_pct,tender_date::text FROM public.bond_issuance')).rows[0])
    .toEqual({final_coupon_pct:2.1,tender_date:'2026-09-19'});
  expect(result.applications[0].stats).toMatchObject({filled_fields:4,preserved_fields:0});
  expect(bucket.objects.has(result.application_receipt)).toBe(true);
 }finally{await engine.close();}
});

it('replays only successful invalid-code child batches and retains each received time',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();const invalid={code:'123457.SH',date:bond.date};
 const upstream=vi.fn(async(_path,query)=>{
   const codes=query.get('codes').split(',');if(codes.includes(invalid.code))throw Error('10003008 invalid stock code');return pricingPayload;
 });
 const observer=issuanceObservationRequests(bucket,'original-split','2026-10-03',upstream);
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES($1,$3,'测试证券'),($2,$3,'测试证券')`,[bond.code,invalid.code,bond.date]);
  const result=await fetchIssuePricing(observer.forBonds([bond,invalid]),[bond,invalid]);expect(result.invalidCodes).toEqual([invalid.code]);
  expect(upstream).toHaveBeenCalledTimes(3);
  const keys=await listObservationKeys(bucket,'original-split');expect(keys).toHaveLength(3);
  const original=await Promise.all(keys.map(k=>readObservation(bucket,'original-split',k)));
  expect(original.filter(o=>o.content.kind==='invalid_code').every(o=>o.record.observed_at===null)).toBe(true);
  upstream.mockImplementation(()=>{throw Error('Replay must not contact Choice');});
  await seal(bucket,'original-split');
  const replay=await replayIssuanceObservations(bucket,db,'original-split','replay-split');
  expect(replay.applications.filter(a=>a.status==='applied')).toHaveLength(1);
  expect(replay.applications.filter(a=>a.status==='skipped_failed_source')).toHaveLength(1);
  expect(replay.applications.filter(a=>a.status==='unrecovered_source')).toHaveLength(1);
  expect(upstream).toHaveBeenCalledTimes(3);
  expect((await engine.query('SELECT final_coupon_pct FROM public.bond_issuance WHERE bond_code=$1',[bond.code])).rows[0].final_coupon_pct).toBe(2.1);
  expect((await engine.query('SELECT final_coupon_pct FROM public.bond_issuance WHERE bond_code=$1',[invalid.code])).rows[0].final_coupon_pct).toBeNull();
 }finally{await engine.close();}
});

it('preserves current nonempty facts, counts conflicts and never moves classification checked date backwards',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name,final_coupon_pct,placement_type,placement_checked_at)
    VALUES($1,$2,'测试证券',3.0,'私募','2026-10-05')`,[bond.code,bond.date]);
  const observer=issuanceObservationRequests(bucket,'original-preserve','2026-10-03',async(path,q)=>q.get('indicators').includes('RAISEWAY')
    ?{function:'CSS',rows:[{code:bond.code,RAISEWAY:'公募',MATURITYDATE:'2029-09-20'}]}:pricingPayload);
  await observer.forBonds([bond])('/choice/css',pricingQuery());
  await observer.forBonds([bond])('/choice/css',new URLSearchParams({codes:bond.code,indicators:'RAISEWAY,MATURITYDATE',options:'Ispandas=1'}));
  await seal(bucket,'original-preserve');
  const result=await replayIssuanceObservations(bucket,db,'original-preserve','replay-preserve');
  expect(result.applications.reduce((sum,a)=>sum+a.stats.conflicting_fields,0)).toBe(2);
  expect((await engine.query('SELECT final_coupon_pct,placement_type,placement_checked_at::text,maturity_date::text FROM public.bond_issuance')).rows[0])
   .toEqual({final_coupon_pct:3,placement_type:'私募',placement_checked_at:'2026-10-05',maturity_date:'2029-09-20'});
 }finally{await engine.close();}
});

it('CTR recovery only inserts absent bonds; an incomplete or corrupt archive is rejected without inventing data',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES($1,$2,'现值证券')`,[bond.code,bond.date]);
  const spec=quantMarketRequests('2026-09-14','2026-09-20').find(s=>s.dataset==='issue');
  const observer=issuanceObservationRequests(bucket,'original-ctr','2026-10-03',async()=>({function:'CTR',fields:[],rows:[
   {SECUCODE:bond.code,ISSUE_DATE:bond.date,ISSUER_NAME:'旧值证券',BOND_TYPE:'证券公司债'},
   {SECUCODE:'123457.SH',ISSUE_DATE:bond.date,ISSUER_NAME:'新增证券',BOND_TYPE:'证券公司债'},
  ]}));
  await observer.request('/choice/ctr',new URLSearchParams(spec.parameters));
  await seal(bucket,'original-ctr');
  const result=await replayIssuanceObservations(bucket,db,'original-ctr','replay-ctr');
  expect(result.applications[0].stats).toMatchObject({inserted_bonds:1,skipped_existing_bonds:1,conflicting_fields:null});
  expect((await engine.query('SELECT issuer_name FROM public.bond_issuance WHERE bond_code=$1',[bond.code])).rows[0].issuer_name).toBe('现值证券');
  await expect(replayIssuanceObservations(bucket,db,'missing-instance','replay-missing')).rejects.toThrow('No archived');
  const {record}=await readObservation(bucket,'original-ctr',observer.results[0].key);bucket.objects.delete(record.content_key);
  const invalid=await replayIssuanceObservations(bucket,db,'original-ctr','replay-invalid');
  expect(invalid).toMatchObject({status:'partial',applications:[{status:'invalid_archive'}]});
 }finally{await engine.close();}
});

it('restores CTR bonds before dependent pricing and placement in one replay, regardless of key order',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  const spec=quantMarketRequests('2026-09-14','2026-09-20').find(s=>s.dataset==='issue');
  const observer=issuanceObservationRequests(bucket,'original-dependent','2026-10-03',async(path,q)=>
   path==='/choice/ctr'?{function:'CTR',rows:[{SECUCODE:bond.code,ISSUE_DATE:bond.date,ISSUER_NAME:'测试证券',BOND_TYPE:'证券公司债'}]}
   :q.get('indicators').includes('RAISEWAY')?{function:'CSS',rows:[{code:bond.code,RAISEWAY:'公募',MATURITYDATE:'2029-09-20'}]}:pricingPayload);
  await observer.request('/choice/ctr',new URLSearchParams(spec.parameters));
  await observer.forBonds([bond])('/choice/css',new URLSearchParams({codes:bond.code,indicators:'RAISEWAY,MATURITYDATE',options:'Ispandas=1'}));
  await observer.forBonds([bond])('/choice/css',pricingQuery());
  await seal(bucket,'original-dependent');
  const result=await replayIssuanceObservations(bucket,db,'original-dependent','replay-dependent');
  expect(result.status).toBe('complete');expect(result.applications[0].source).toBe('issue-detail');
  expect((await engine.query('SELECT tender_date::text,tender_announcement_date::text,final_coupon_pct,placement_type FROM public.bond_issuance')).rows[0])
   .toEqual({tender_date:'2026-09-19',tender_announcement_date:'2026-09-01',final_coupon_pct:2.1,placement_type:'公募'});
 }finally{await engine.close();}
});

it('reports corrected issuance-date context and incomplete source coverage without filling stale facts',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES($1,'2026-09-18','测试证券')`,[bond.code]);
  const observer=issuanceObservationRequests(bucket,'original-context','2026-10-03',async()=>pricingPayload);
  await observer.forBonds([bond])('/choice/css',pricingQuery());
  await seal(bucket,'original-context');
  const result=await replayIssuanceObservations(bucket,db,'original-context','replay-context');
  expect(result).toMatchObject({status:'partial',applications:[{stats:{context_conflicts:1,stored:0,filled_fields:0}}]});
  expect((await engine.query('SELECT final_coupon_pct FROM public.bond_issuance')).rows[0].final_coupon_pct).toBeNull();
  const missing=issuanceObservationRequests(bucket,'original-empty','2026-10-03',async()=>({function:'CSS',rows:[]}));
  await missing.forBonds([bond])('/choice/css',pricingQuery());
  await seal(bucket,'original-empty');
  expect(await replayIssuanceObservations(bucket,db,'original-empty','replay-empty')).toMatchObject({status:'partial',applications:[{missing_codes:[bond.code]}]});
  const failed=issuanceObservationRequests(bucket,'original-source-error','2026-10-03',async()=>{throw Error('upstream unavailable');});
  await expect(failed.forBonds([bond])('/choice/css',pricingQuery())).rejects.toThrow('upstream unavailable');
  await seal(bucket,'original-source-error');
  expect(await replayIssuanceObservations(bucket,db,'original-source-error','replay-source-error')).toMatchObject({status:'partial',applications:[{status:'unrecovered_source'}]});
 }finally{await engine.close();}
});

it('separates application success from final field coverage and detects an unarchived original request',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name) VALUES($1,$2,'测试证券')`,[bond.code,bond.date]);
  const observer=issuanceObservationRequests(bucket,'original-coverage','2026-10-03',async()=>({function:'CSS',rows:[{...pricingPayload.rows[0],TENDERFINALCOUPON:null}]}));
  await observer.forBonds([bond])('/choice/css',pricingQuery());await saveLiveObservationManifest(bucket,'original-coverage',observer.results);
  const partial=await replayIssuanceObservations(bucket,db,'original-coverage','replay-coverage');
  expect(partial).toMatchObject({status:'partial',application_status:'complete',coverage_status:'partial',applications:[{stats:{missing_fields:[{code:bond.code,fields:['final_coupon_pct']}]}}]});
  const quarantined=issuanceObservationRequests(bucket,'original-quarantine','2026-10-03',async()=>({function:'CSS',rows:[{...pricingPayload.rows[0],TENDERDATE:'2026/10/5'}]}));
  await quarantined.forBonds([bond])('/choice/css',pricingQuery());await saveLiveObservationManifest(bucket,'original-quarantine',quarantined.results);
  expect(await replayIssuanceObservations(bucket,db,'original-quarantine','replay-quarantine')).toMatchObject({status:'partial',applications:[{stats:{quarantined_bonds:1}}]});
  const noData=issuanceObservationRequests(bucket,'original-no-data','2026-10-03',async()=>{throw Error('10000009 no data');});
  await expect(noData.forBonds([bond])('/choice/css',pricingQuery())).rejects.toThrow('no data');await saveLiveObservationManifest(bucket,'original-no-data',noData.results);
  expect(await replayIssuanceObservations(bucket,db,'original-no-data','replay-no-data')).toMatchObject({status:'partial',coverage_status:'partial'});
  const gap=issuanceObservationRequests(bucket,'original-manifest-gap','2026-10-03',async()=>pricingPayload);
  await gap.forBonds([bond])('/choice/css',pricingQuery());
  const failedBond={code:'123457.SH',date:bond.date};const other=new URLSearchParams(pricingQuery());other.set('codes',failedBond.code);
  bucket.put.mockRejectedValueOnce(Error('archive unavailable'));
  await gap.forBonds([failedBond])('/choice/css',other);await saveLiveObservationManifest(bucket,'original-manifest-gap',gap.results);
  expect(await replayIssuanceObservations(bucket,db,'original-manifest-gap','replay-manifest-gap')).toMatchObject({status:'partial',coverage_status:'unknown',request_set_verified:false});
 }finally{await engine.close();}
});

it('quarantined sources remain partial even when current database fields are complete',async()=>{
 const {engine,db}=await database(),bucket=observationBucket();
 try{
  await engine.query(`INSERT INTO public.bond_issuance(bond_code,issue_date,issuer_name,tender_date,final_coupon_pct,issuance_rating,tender_announcement_date)
    VALUES($1,$2,'测试证券','2026-09-19',2.1,'AAA','2026-09-01')`,[bond.code,bond.date]);
  const observer=issuanceObservationRequests(bucket,'original-full-quarantine','2026-10-03',async()=>({function:'CSS',rows:[{...pricingPayload.rows[0],TENDERDATE:'2026/10/5'}]}));
  await observer.forBonds([bond])('/choice/css',pricingQuery());await saveLiveObservationManifest(bucket,'original-full-quarantine',observer.results);
  expect(await replayIssuanceObservations(bucket,db,'original-full-quarantine','replay-full-quarantine'))
    .toMatchObject({status:'partial',application_status:'complete',coverage_status:'partial',applications:[{stats:{quarantined_bonds:1,missing_fields:[]}}]});
 }finally{await engine.close();}
});
