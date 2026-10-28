import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {couponInputBatch} from '../segmented-coupon.mjs';
import {rawQuoteCodes,rawQuoteRatingIndex,rawQuoteRatings} from '../raw-quote-context.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('separate code index keeps split same-date rating fields and latest complete public observations',()=>{
  const bonds=[{bond_code:'a.sh',placement_type:'公募'},{bond_code:'B.SH',placement_type:'私募'},{bond_code:'A.SH',placement_type:'公募'}];
  const rows=[
    {date:'2025-01-01',bond_code:'A.SH',rating:'AAA',tenor:3},
    {date:'2025-01-01',bond_code:'A.SH',coupon:2,issue_size:10,issuance_rating:'AA+'},
    {date:'2025-01-02',bond_code:'A.SH',rating:'AAA',tenor:3,coupon:2,issue_size:10,issuance_rating:'AAA'},
    {date:'2025-01-03',bond_code:'A.SH',rating:'AAA',issuance_rating:'AA'},
    {date:'2025-01-03',bond_code:'B.SH',rating:'AAA',tenor:3,coupon:2,issue_size:10,issuance_rating:'AA'},
  ];
  assert.deepEqual(rawQuoteCodes(bonds,'public_only'),['A.SH']);
  assert.deepEqual([...rawQuoteRatingIndex(rows,rawQuoteCodes(bonds,'public_only'))],[['A.SH','AAA']]);
  assert.deepEqual([...rawQuoteRatingIndex(rows,rawQuoteCodes(bonds,'all'))],[...rawQuoteRatings(rows,bonds,'all')]);
});
test('input batches restore a split UTF-8 row, verify the preceding checkpoint and notify after archive',async()=>{
  const parent='test-parent',prefix='quant-trial/runs/2026-10-26/'+parent;
  const source=Buffer.from(JSON.stringify({as_of_date:'2026-10-26',issuance_scope:'public_only',datasets:{issuer_daily:[{issuer:'中文发行人',observation_date:'2026-10-23',date:'2026-10-23',yield_intercept:null}]}}));
  const split=source.indexOf(Buffer.from('中文'))+1,files=new Map([[prefix+'/inputs.json',source]]),events=[];
  const io={sha256:async bytes=>hash(bytes),putJson:async(_,key,value)=>{if(!files.has(key))files.set(key,Buffer.from(JSON.stringify(value)));return key},readJson:async(_,key,limit,expected)=>{const bytes=files.get(key);assert.ok(bytes);if(expected)assert.equal(hash(bytes),expected);return JSON.parse(bytes)}};
  const env={ARTIFACTS:{head:async key=>files.has(key)?{customMetadata:{sha256:hash(files.get(key))}}:null,
    get:async(key,opts)=>{const bytes=files.get(key),part=bytes.subarray(opts.range.offset,opts.range.offset+opts.range.length);assert.equal(opts.onlyIf.etagMatches,hash(source));return{body:true,arrayBuffer:async()=>part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength)}}},
    INFERENCE:{get:async id=>({sendEvent:async event=>{assert.equal(id,parent);assert.ok(files.has(event.payload.key));events.push(event)}})}};
  const caches=[];
  const step=()=>{const cache=new Map();caches.push(cache);return{do:async(name,opts,fn)=>{if(!cache.has(name))cache.set(name,structuredClone(await fn()));return structuredClone(cache.get(name))}}};
  const input={key:prefix+'/inputs.json',size:source.length,sha256:hash(source),etag:hash(source)};
  const id=index=>`${hash(Buffer.from(parent+'coupon-segments-v2')).slice(0,20)}-segments-${index}`;
  const event=(index,start,end,previous)=>({instanceId:id(index),payload:{as_of_date:'2026-10-26',input_batch:{parent_id:parent,parent_prefix:prefix,index,start,end,input,terms:{issuer:'中文发行人'},model_version:'0123456789abcdef0123',previous}}});
  const first=await couponInputBatch(env,step(),event(0,0,split),io),secondEvent=event(1,split,source.length,first),secondStep=step();
  const second=await couponInputBatch(env,secondStep,secondEvent,io),index=await io.readJson(null,second.key);
  assert.equal(index.checkpoint.scanner.phase,'done');assert.equal(index.checkpoint.scanner.counts.issuer_daily,1);
  assert.equal((await io.readJson(null,index.groups[0].key))[0].issuer,'中文发行人');
  await couponInputBatch(env,secondStep,secondEvent,io);assert.equal(events.length,2);
  await assert.rejects(couponInputBatch(env,step(),event(1,split,source.length,{...first,sha256:'0'.repeat(64)}),io));
  files.set(second.key,Buffer.from('{}'));
  await assert.rejects(couponInputBatch(env,step(),secondEvent,io),/Immutable segment artifact differs/);
});
