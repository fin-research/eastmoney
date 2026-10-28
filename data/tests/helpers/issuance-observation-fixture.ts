import { canonical, observationDescriptor, observationHash, observationQuality, sanitizeObservation } from '../../src/sync/issuance-observation-contract.ts';
import { ISSUE_FIELDS, ISSUE_PRICING_FIELDS } from '../../src/sync/quant-input-contract.ts';
import { recordSchema } from '../../src/sync/issuance-observation-store.ts';

/** Synthetic, deterministic consumer contract example. Every date and value is invented. */
export function issuanceObservationFixture() {
  const instance='synthetic-contract-v1',prefix='data-observations/bond-issuance/'+instance+'/';
  const bonds=[{code:'123456.SH',date:'2026-09-30'},{code:'123457.SH',date:'2026-09-30'}];
  const cases=[
    {path:'/choice/ctr',query:new URLSearchParams({reportName:'BondIssueDetail',indicators:ISSUE_FIELDS.join(','),options:'StartDate=2026-09-30,EndDate=2026-09-30,Ispandas=1'}),
      bonds:[],value:{function:'CTR',rows:[{SECUCODE:bonds[0]!.code,ISSUE_DATE:bonds[0]!.date,
        BOND_NAME_ABBR:'合成测试债',ACTUAL_ISSUE_SCALE:1e-7,BOND_EXPIRE_YEAR:1e21,PI_RATE_TYPE:'固定利率',ISSUER_NAME:'合成发行人'}]}},
    {path:'/choice/css',query:new URLSearchParams({codes:bonds.map(b=>b.code).reverse().join(','),indicators:ISSUE_PRICING_FIELDS.join(','),options:'Ispandas=1'}),
      bonds,value:{function:'CSS',rows:[{code:bonds[0]!.code,TENDERDATE:'2026/9/29',TENDERFINALCOUPON:2.1,
        ISSCORPCREDITRAT:'AAA',TENDERANNCDATE:'2026/9/1',UNREQUESTED:'discard'},
        {code:bonds[1]!.code,TENDERDATE:'2026/10/1',TENDERFINALCOUPON:null,ISSCORPCREDITRAT:'—'}]}},
    {path:'/choice/css',query:new URLSearchParams({codes:bonds[0]!.code,indicators:'RAISEWAY,MATURITYDATE',options:'Ispandas=1'}),
      bonds:[bonds[0]!],value:{function:'CSS',rows:[{code:bonds[0]!.code,RAISEWAY:'公募',MATURITYDATE:'2029/9/30'}]}},
  ];
  const objects:Array<{key:string;bytes:string;uploaded:string;etag:string;version:string}>=[],requests=[];
  for(const input of cases) {
    const request=observationDescriptor(input.path,input.query,input.bonds)!;
    const payload=sanitizeObservation(request,input.value),content={kind:'response',payload};
    const bytes=canonical(content),checksum=observationHash(bytes),contentKey=prefix+'contents/'+checksum+'.json';
    const key=prefix+'requests/'+request.source+'/'+observationHash(canonical(request))+'.json';
    const record=recordSchema.parse({schema_version:1,instance_id:instance,scheduled_date:'2026-09-30',request,
      request_sha256:observationHash(canonical(request)),content_key:contentKey,content_sha256:checksum,
      response_received_at:'2026-09-30T01:00:00.000Z',observed_at:'2026-09-30T01:00:00.000Z',
      archived_at:'2026-09-30T01:00:00.001Z',final_coupon_published_at:null,quality:observationQuality(request,payload)});
    for(const [objectKey,body] of [[contentKey,bytes],[key,canonical(record)]])objects.push({
      key:objectKey!,bytes:body!,uploaded:'2026-09-30T01:00:00.002Z',etag:observationHash(body!),version:'synthetic-v1'});
    requests.push({key,source:request.source,status:'archived',outcome:'response'});
  }
  const manifestBytes=canonical({schema_version:1,instance_id:instance,requests});
  objects.push({key:prefix+'live-manifest.json',bytes:manifestBytes,uploaded:'2026-09-30T01:00:00.003Z',
    etag:observationHash(manifestBytes),version:'synthetic-v1'});
  return {schema_version:1,scope:'synthetic contract fixture; not production observations',instance,
    cutoff:'2026-09-30T02:00:00.000Z',objects};
}
