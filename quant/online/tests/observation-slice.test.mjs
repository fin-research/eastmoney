import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonical,digest,quality,validateObservation} from '../observation-contract.mjs';
import {readIssuanceObservationSlice} from '../observation-slice.mjs';
import {observationStore} from '../observation-store.mjs';

const fixtureBytes=await readFile(new URL('./fixtures/issuance-observations-v1.json',import.meta.url),'utf8');
const fixture=JSON.parse(fixtureBytes);
const fixtureProvenance=JSON.parse(await readFile(new URL('./fixtures/issuance-observations-v1.provenance.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(fixture);
const pricingKey=f=>f.objects.find(object=>object.key.includes('/requests/issue-pricing/')).key;
function replace(object,value) {object.bytes=canonical(value);object.etag=digest(object.bytes);}
function pricing(f,transform) {
  const mapping=f.objects.find(object=>object.key===pricingKey(f)),record=JSON.parse(mapping.bytes);
  const body=f.objects.find(object=>object.key===record.content_key),content=transform(JSON.parse(body.bytes));
  replace(body,content);record.content_sha256=digest(body.bytes);
  record.content_key=body.key.slice(0,body.key.indexOf('/contents/'))+'/contents/'+record.content_sha256+'.json';
  body.key=record.content_key;
  record.observed_at=content.kind==='response'?record.response_received_at:null;
  record.quality=content.kind==='response'?quality(record.request,content.payload):null;
  replace(mapping,record);
  const manifest=f.objects.find(object=>object.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);
  value.requests.find(row=>row.key===mapping.key).outcome=content.kind;replace(manifest,value);
  return f;
}
function detail(f,transform) {
  const mapping=f.objects.find(row=>row.key.includes('/requests/issue-detail/')),record=JSON.parse(mapping.bytes);
  const body=f.objects.find(row=>row.key===record.content_key),content=transform(JSON.parse(body.bytes));
  replace(body,content);record.content_sha256=digest(body.bytes);
  body.key=body.key.slice(0,body.key.indexOf('/contents/'))+'/contents/'+record.content_sha256+'.json';
  record.content_key=body.key;record.quality=content.kind==='response'?quality(record.request,content.payload):null;
  record.observed_at=content.kind==='response'?record.response_received_at:null;replace(mapping,record);
  const manifest=f.objects.find(row=>row.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);
  value.requests.find(row=>row.key===mapping.key).outcome=content.kind;replace(manifest,value);
}
function later(f,instance,time) {
  const old=f.instance;f.instance=instance;
  for(const object of f.objects) {
    object.key=object.key.replace('/'+old+'/','/'+instance+'/');
    const value=JSON.parse(object.bytes);
    if(value.request) {
      value.instance_id=instance;value.content_key=value.content_key.replace('/'+old+'/','/'+instance+'/');
      value.response_received_at=time;value.observed_at=value.observed_at===null?null:time;
      value.archived_at=new Date(Date.parse(time)+1).toISOString();replace(object,value);
    } else if(value.requests) {
      value.instance_id=instance;value.requests.forEach(row=>row.key=row.key.replace('/'+old+'/','/'+instance+'/'));
      replace(object,value);
    }
    object.uploaded=new Date(Date.parse(time)+(object.key.endsWith('live-manifest.json')?3:2)).toISOString();
  }
  return f;
}
function bucket(fixtures,{pageSize=1000}={}) {
  const objects=new Map(fixtures.flatMap(f=>f.objects).map(object=>[object.key,object]));
  const calls=[],utf8=new TextEncoder();
  const metadata=object=>({key:object.key,size:utf8.encode(object.bytes).byteLength,
    etag:object.etag,version:object.version,uploaded:new Date(object.uploaded)});
  const adapter=new Proxy({
    async get(key) {
      calls.push(['get',key]);const object=objects.get(key);if(!object)return null;
      return {...metadata(object),body:new ReadableStream({start(controller){controller.enqueue(utf8.encode(object.bytes));controller.close();}})};
    },
    async list({prefix,cursor,limit}) {
      calls.push(['list',prefix]);const rows=[...objects.values()].filter(object=>object.key.startsWith(prefix)).sort((a,b)=>a.key.localeCompare(b.key));
      const start=Number(cursor??0),end=start+Math.min(limit,pageSize);
      return {objects:rows.slice(start,end).map(metadata),truncated:end<rows.length,...(end<rows.length?{cursor:String(end)}:{})};
    },
  },{get(target,key){assert.ok(['get','list'].includes(key),'Non-read capability requested: '+String(key));return target[key];}});
  return {adapter,calls,objects};
}
const read=(adapter,options={})=>readIssuanceObservationSlice(adapter,{instances:[fixture.instance],cutoff:fixture.cutoff,...options});
const coupon=result=>result.fields.find(row=>row.source==='issue-pricing'&&row.code==='123456.SH'&&row.field==='TENDERFINALCOUPON');

test('Data-owned fixture preserves canonical Chinese/floating-point bytes, raw fields and unknown first publication',async()=>{
  assert.equal(digest(fixtureBytes),fixtureProvenance.sha256);
  assert.match(fixtureProvenance.owner_revision,/^[a-f0-9]{40}$/);
  for(const object of fixture.objects.filter(row=>row.key.includes('/requests/'))) {
    const record=JSON.parse(object.bytes),body=fixture.objects.find(row=>row.key===record.content_key);
    assert.equal(validateObservation(fixture.instance,object.key,record,body.bytes).record.observed_at,'2026-09-30T01:00:00.000Z');
  }
  const {adapter,calls}=bucket([fixture]),result=await read(adapter);
  assert.equal(result.request_coverage,'complete');assert.equal(result.field_coverage,'partial');
  assert.equal(coupon(result).value,2.1);assert.equal(result.first_publication_known,false);
  assert.equal(coupon(result).provenance.first_publication_at,null);
  assert.equal(result.fields.find(row=>row.field==='ACTUAL_ISSUE_SCALE').value,1e-7);
  assert.equal(result.fields.find(row=>row.field==='BOND_EXPIRE_YEAR').value,1e21);
  assert.ok(result.fields.some(row=>row.code==='123457.SH'&&row.state==='quarantined'));
  assert.ok(calls.every(([operation,key])=>['get','list'].includes(operation)&&key.startsWith('data-observations/bond-issuance/')));
  assert.equal(result.usage.reads,7);
});
test('cutoff requires an explicit valid timezone and every timestamp is strictly before it',async()=>{
  const {adapter,calls}=bucket([fixture]);
  for(const cutoff of ['2026-09-30','2026-09-30T02:00:00','2026-02-30T01:00:00Z','2026-09-30T24:00:00Z'])
    await assert.rejects(read(adapter,{cutoff}),/timestamp/);
  assert.equal(calls.length,0);
  const f=clone();f.objects.forEach(object=>object.uploaded='2026-09-30T00:59:59.999Z');
  const result=await read(bucket([f]).adapter,{cutoff:'2026-09-30T09:00:00.000+08:00'});
  assert.ok(!coupon(result));assert.ok(result.issues.some(row=>row.reason==='response_at_or_after_cutoff'));
});
test('an early observed_at cannot make a late request mapping or content object available',async()=>{
  for(const which of ['mapping','content']) {
    const f=clone(),mapping=f.objects.find(row=>row.key===pricingKey(f)),record=JSON.parse(mapping.bytes);
    (which==='mapping'?mapping:f.objects.find(row=>row.key===record.content_key)).uploaded=f.cutoff;
    const result=await read(bucket([f]).adapter);
    assert.notEqual(coupon(result)?.state,'value');assert.equal(coupon(result)?.value??null,null);
    assert.equal(result.request_coverage,'unknown');
    assert.ok(result.issues.some(row=>row.reason==='object_at_or_after_cutoff'));
  }
});
test('missing or late manifest leaves request completeness unknown without retroactive evidence',async()=>{
  for(const mode of ['missing','late','corrupt']) {
    const f=clone(),manifest=f.objects.find(row=>row.key.endsWith('live-manifest.json'));
    if(mode==='missing')f.objects=f.objects.filter(row=>row!==manifest);
    else if(mode==='late')manifest.uploaded=f.cutoff;
    else replace(manifest,{schema_version:2});
    const result=await read(bucket([f]).adapter);
    assert.equal(result.request_coverage,'unknown');assert.equal(coupon(result).value,null);
    assert.equal(coupon(result).state,'availability_unknown');
    assert.equal(coupon(result).last_known_observation.value,2.1);
  }
});
test('later null, empty, absent and missing-code results do not fall back to old nonempty values',async()=>{
  for(const state of ['null','empty','absent','missing_code']) {
    const next=later(clone(),'synthetic-later-'+state,'2026-09-30T01:10:00.000Z');
    pricing(next,content=>{
      const row=content.payload.rows[0];
      if(state==='missing_code')content.payload.rows.shift();
      else if(state==='absent')delete row.TENDERFINALCOUPON;
      else row.TENDERFINALCOUPON=state==='null'?null:'—';
      return content;
    });
    const result=await read(bucket([fixture,next]).adapter,{instances:[next.instance,fixture.instance]});
    assert.equal(coupon(result).state,state);assert.equal(coupon(result).value,null);
    assert.equal(result.field_coverage,'partial');
  }
});
test('same-time corrections are ambiguous; same-time identical observations merge deterministically',async()=>{
  const same=later(clone(),'synthetic-same','2026-09-30T01:00:00.000Z');
  let result=await read(bucket([fixture,same]).adapter,{instances:[same.instance,fixture.instance]});
  assert.equal(coupon(result).state,'value');assert.equal(coupon(result).observation_keys.length,2);
  pricing(same,content=>{content.payload.rows[0].TENDERFINALCOUPON=2.2;return content;});
  result=await read(bucket([fixture,same]).adapter,{instances:[fixture.instance,same.instance]});
  assert.equal(coupon(result).state,'ambiguous');assert.equal(coupon(result).value,null);
});
test('source failures and invalid response codes remain explicit instead of becoming empty successes',async()=>{
  const failed=later(clone(),'synthetic-failed','2026-09-30T01:10:00.000Z');
  pricing(failed,()=>({kind:'source_error',error_code:null}));
  let result=await read(bucket([fixture,failed]).adapter,{instances:[fixture.instance,failed.instance]});
  assert.equal(coupon(result).state,'failed');assert.equal(coupon(result).provenance.observed_at,null);
  const invalid=later(clone(),'synthetic-invalid','2026-09-30T01:10:00.000Z');
  pricing(invalid,content=>{content.payload.rows[0].code='UNKNOWN.SH';return content;});
  result=await read(bucket([fixture,invalid]).adapter,{instances:[fixture.instance,invalid.instance]});
  assert.equal(coupon(result).state,'failed');assert.equal(coupon(result).failure,'invalid_response_codes');
});
test('hash damage and cross-instance references are rejected before they can supply field values',async()=>{
  for(const mode of ['checksum','cross_instance','quality','manifest_outcome']) {
    const f=clone(),mapping=f.objects.find(row=>row.key===pricingKey(f)),record=JSON.parse(mapping.bytes);
    if(mode==='checksum')f.objects.find(row=>row.key===record.content_key).bytes+=' ';
    else if(mode==='cross_instance'){record.content_key=record.content_key.replace('/'+f.instance+'/','/outside/');replace(mapping,record);}
    else if(mode==='quality'){record.quality.rows[0].quarantined=true;replace(mapping,record);}
    else {const manifest=f.objects.find(row=>row.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);value.requests.find(row=>row.key===mapping.key).outcome='source_error';replace(manifest,value);}
    const result=await read(bucket([f]).adapter);
    assert.equal(result.request_coverage,'unknown');
    assert.notEqual(coupon(result)?.state,'value');assert.equal(coupon(result)?.value??null,null);
  }
});
test('original issuance context and expected-but-unobserved bonds remain visible gaps',async()=>{
  const result=await read(bucket([fixture]).adapter,{bonds:[{code:'123456.SH',date:'2026-10-01'},{code:'123999.SH',date:'2026-09-30'}]});
  assert.equal(coupon(result).state,'context_mismatch');assert.equal(coupon(result).value,null);
  assert.deepEqual(result.missing_expected_bonds,[{code:'123999.SH',date:'2026-09-30'}]);
  await assert.rejects(read(bucket([fixture]).adapter,{bonds:[{code:'123456.SH',date:null}]}),/Invalid expected/);
});
test('paged enumeration is complete, scoped, bounded and detects repeated cursors or capture changes',async()=>{
  const result=await read(bucket([fixture],{pageSize:1}).adapter);
  assert.equal(result.usage.pages,3);assert.equal(result.request_coverage,'complete');
  const stuck={get:async()=>null,list:async()=>({objects:[],truncated:true,cursor:'same'})};
  await assert.rejects(read(stuck),/invalid_list_cursor/);
  const source=bucket([fixture]),changed={list:source.adapter.list,get:async key=>{
    const object=await source.adapter.get(key);if(object&&key.includes('/requests/'))object.version='changed';return object;
  }};
  const partial=await read(changed);
  assert.ok(partial.issues.some(row=>row.reason==='object_changed_during_capture'));
  const store=observationStore(source.adapter,[fixture.instance],fixture.cutoff);
  await assert.rejects(store.read('quant-trial/models/current.json'),/outside/);
});
test('request/read/page/byte/field budgets fail closed rather than returning a truncated slice',async()=>{
  for(const limits of [{maxRequests:2},{maxReads:1},{maxPages:1},{maxBytes:20},{maxObjectBytes:20},{maxFields:1}]) {
    const source=bucket([fixture],{pageSize:1});
    await assert.rejects(read(source.adapter,{limits}),/budget/);
  }
  await assert.rejects(read(bucket([fixture]).adapter,{limits:{maxBytes:1024*1024*1024}}),/invalid_limits/);
  const source=bucket([fixture]),lying={list:source.adapter.list,get:async key=>{
    const object=await source.adapter.get(key);if(object)object.size=1;return object;
  }};
  await assert.rejects(read(lying,{limits:{maxObjectBytes:20}}),/object_byte_budget/);
});
test('BOM in content, mapping or manifest cannot bypass raw byte hashes or canonical owner encoding',async()=>{
  for(const role of ['content','mapping','manifest']) {
    const f=clone(),mapping=f.objects.find(row=>row.key===pricingKey(f)),record=JSON.parse(mapping.bytes);
    const object=role==='content'?f.objects.find(row=>row.key===record.content_key):
      role==='mapping'?mapping:f.objects.find(row=>row.key.endsWith('live-manifest.json'));
    object.bytes='\uFEFF'+object.bytes;object.etag=digest(object.bytes);
    const result=await read(bucket([f]).adapter);
    assert.equal(result.request_coverage,'unknown');assert.notEqual(coupon(result)?.state,'value');
    assert.equal(coupon(result)?.value??null,null);
    assert.ok(result.captured_objects.some(row=>row.key===object.key&&row.sha256===digest(object.bytes)));
  }
});
test('later missing/corrupt content and declared archive failures block latest values while preserving old facts',async()=>{
  for(const role of ['missing','corrupt','archive_failure','manifest_mismatch']) {
    const f=later(clone(),'synthetic-'+role,'2026-09-30T01:10:00.000Z');
    const mapping=f.objects.find(row=>row.key===pricingKey(f)),record=JSON.parse(mapping.bytes);
    if(role==='missing')f.objects=f.objects.filter(row=>row.key!==record.content_key);
    else if(role==='corrupt')f.objects.find(row=>row.key===record.content_key).bytes+=' ';
    else {const manifest=f.objects.find(row=>row.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);
      const row=value.requests.find(item=>item.key===mapping.key);
      if(role==='archive_failure')row.status='failed';else row.outcome='source_error';replace(manifest,value);}
    const result=await read(bucket([fixture,f]).adapter,{instances:[fixture.instance,f.instance]});
    assert.notEqual(coupon(result).state,'value');assert.equal(coupon(result).value,null);
    assert.equal(coupon(result).last_known_observation.value,2.1);
    assert.equal(coupon(result).state,'availability_unknown');
  }
});
test('CTR failures block affected old fields even though the original request has no bonds',async()=>{
  const f=later(clone(),'synthetic-ctr-failed','2026-09-30T01:10:00.000Z');
  const mapping=f.objects.find(row=>row.key.includes('/requests/issue-detail/')),record=JSON.parse(mapping.bytes);
  const body=f.objects.find(row=>row.key===record.content_key);
  replace(body,{kind:'source_error',error_code:null});record.content_sha256=digest(body.bytes);
  body.key=body.key.slice(0,body.key.indexOf('/contents/'))+'/contents/'+record.content_sha256+'.json';
  record.content_key=body.key;record.quality=null;record.observed_at=null;replace(mapping,record);
  const manifest=f.objects.find(row=>row.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);
  value.requests.find(row=>row.key===mapping.key).outcome='source_error';replace(manifest,value);
  const result=await read(bucket([fixture,f]).adapter,{instances:[fixture.instance,f.instance]});
  const field=result.fields.find(row=>row.source==='issue-detail'&&row.field==='ACTUAL_ISSUE_SCALE');
  assert.equal(result.request_coverage,'complete');assert.equal(field.state,'source_unavailable');assert.equal(field.value,null);
  assert.equal(field.last_known_observation.value,1e-7);
  assert.ok(result.source_barriers.some(row=>row.reason==='source_error'));
});
test('failed size, UTF-8 and mid-stream reads consume actual bytes without refund',async()=>{
  const keys=[1,2,3].map(n=>'data-observations/bond-issuance/'+fixture.instance+'/contents/'+String(n).padStart(64,'0')+'.json');
  const adapter=kind=>({list:async()=>({objects:[],truncated:false}),get:async key=>({
    key,size:1,etag:'synthetic',version:'synthetic',uploaded:new Date('2026-09-30T01:00:00.000Z'),
    body:new ReadableStream({start(controller){
      if(kind==='size'){controller.enqueue(new Uint8Array(20));controller.close();}
      else if(kind==='utf8'){controller.enqueue(new Uint8Array([255]));controller.close();}
      else controller.enqueue(new Uint8Array([65]));
    },pull(controller){if(kind==='stream')controller.error(new Error('synthetic-stream-error'));}}),
  })});
  let store=observationStore(adapter('size'),[fixture.instance],fixture.cutoff,{maxBytes:30});
  await assert.rejects(store.read(keys[0]),/size_mismatch/);assert.equal(store.usage().bytes,20);
  await assert.rejects(store.read(keys[1]),/total_byte_budget/);assert.equal(store.usage().bytes,40);
  await assert.rejects(store.read(keys[2]),/total_byte_budget/);
  store=observationStore(adapter('utf8'),[fixture.instance],fixture.cutoff,{maxBytes:2});
  await assert.rejects(store.read(keys[0]));await assert.rejects(store.read(keys[1]));assert.equal(store.usage().bytes,2);
  await assert.rejects(store.read(keys[2]),/total_byte_budget/);
  store=observationStore(adapter('stream'),[fixture.instance],fixture.cutoff);
  await assert.rejects(store.read(keys[0]),/synthetic-stream-error/);assert.equal(store.usage().bytes,1);
});
test('CTR no-data, empty and missing previously observed codes cannot silently retain latest values',async()=>{
  for(const mode of ['no_data','empty','missing']) {
    const f=later(clone(),'synthetic-ctr-'+mode,'2026-09-30T01:10:00.000Z');
    detail(f,content=>{
      if(mode==='no_data')return {kind:'no_data',error_code:10000009};
      content.payload.rows=mode==='empty'?[]:[{...content.payload.rows[0],SECUCODE:'123458.SH'}];return content;
    });
    let result=await read(bucket([fixture,f]).adapter,{instances:[fixture.instance,f.instance]});
    let field=result.fields.find(row=>row.source==='issue-detail'&&row.code==='123456.SH'&&row.field==='ACTUAL_ISSUE_SCALE');
    assert.equal(field.state,'source_unavailable');assert.equal(field.value,null);assert.equal(field.last_known_observation.value,1e-7);
    const fresh=later(clone(),'synthetic-fresh-'+mode,'2026-09-30T01:20:00.000Z');
    result=await read(bucket([fixture,f,fresh]).adapter,{instances:[fixture.instance,f.instance,fresh.instance]});
    field=result.fields.find(row=>row.source==='issue-detail'&&row.code==='123456.SH'&&row.field==='ACTUAL_ISSUE_SCALE');
    assert.equal(field.state,'value');assert.equal(field.value,1e-7);
  }
});
test('CTR same-time omission is ambiguous and an unrelated original query range preserves old observations',async()=>{
  const empty=later(clone(),'synthetic-same-empty','2026-09-30T01:00:00.000Z');
  detail(empty,content=>{content.payload.rows=[];return content;});
  let result=await read(bucket([fixture,empty]).adapter,{instances:[fixture.instance,empty.instance]});
  assert.equal(result.fields.find(row=>row.source==='issue-detail'&&row.field==='ACTUAL_ISSUE_SCALE').state,'ambiguous');
  const other=later(clone(),'synthetic-other-range','2026-09-30T01:10:00.000Z');
  detail(other,content=>{content.payload.rows=[];return content;});
  const mapping=other.objects.find(row=>row.key.includes('/requests/issue-detail/')),record=JSON.parse(mapping.bytes),oldKey=mapping.key;
  record.request.parameters.options='StartDate=2026-09-29,EndDate=2026-09-29,Ispandas=1';
  record.request_sha256=digest(canonical(record.request));mapping.key=oldKey.slice(0,oldKey.lastIndexOf('/')+1)+record.request_sha256+'.json';
  replace(mapping,record);const manifest=other.objects.find(row=>row.key.endsWith('live-manifest.json')),value=JSON.parse(manifest.bytes);
  value.requests.find(row=>row.key===oldKey).key=mapping.key;replace(manifest,value);
  result=await read(bucket([fixture,other]).adapter,{instances:[fixture.instance,other.instance]});
  assert.equal(result.fields.find(row=>row.source==='issue-detail'&&row.field==='ACTUAL_ISSUE_SCALE').state,'value');
});
test('stream cancellation rejection cannot downgrade a hard budget failure into a partial slice',async()=>{
  for(const declaredSize of [1,20]) {
    let canceled=0;
    const adapter={list:async()=>({objects:[],truncated:false}),get:async key=>({
      key,size:declaredSize,etag:'synthetic',version:'synthetic',uploaded:new Date('2026-09-30T01:00:00.000Z'),
      body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(20));},
        cancel(){canceled++;throw new Error('synthetic-cleanup-rejection');}}),
    })};
    await assert.rejects(read(adapter,{limits:{maxBytes:10}}),/total_byte_budget/);
    assert.equal(canceled,1);
  }
});
