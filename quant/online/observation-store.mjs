import { digest, instancePrefix, instant } from './observation-contract.mjs';

const CAPS=Object.freeze({maxInstances:32,maxRequests:4096,maxReads:8193,maxPages:128,maxFields:20000,
  maxBytes:32*1024*1024,maxObjectBytes:8*1024*1024,pageSize:1000});
export class ObservationStoreError extends Error {
  constructor(code) { super(code); this.name='ObservationStoreError'; this.code=code; }
}
const fail=code=>{throw new ObservationStoreError(code);};
export function readLimits(overrides={}) {
  if(!overrides || typeof overrides!=='object' || Array.isArray(overrides)
    || Object.keys(overrides).some(key=>!Object.hasOwn(CAPS,key)))fail('invalid_limits');
  const values={...CAPS,...overrides};
  for(const [key,value] of Object.entries(values))if(!Number.isInteger(value)||value<1||value>CAPS[key])fail('invalid_limits');
  return Object.freeze(values);
}
function metadata(object,key) {
  if(!object || object.key!==key || !(object.uploaded instanceof Date) || !Number.isFinite(object.uploaded.getTime())
    || !Number.isSafeInteger(object.size)||object.size<0||typeof object.etag!=='string'||!object.etag
    ||typeof object.version!=='string'||!object.version)fail('invalid_object_metadata');
  return {key,size:object.size,etag:object.etag,version:object.version,uploaded:object.uploaded.toISOString()};
}
const identity=meta=>JSON.stringify(meta);
async function cancel(stream) { try {await stream?.cancel();} catch { /* Cleanup cannot replace the validation failure. */ } }
async function boundedBody(object,limit,consume) {
  if(!object.body || typeof object.body.getReader!=='function')fail('missing_object_body');
  const reader=object.body.getReader(),chunks=[];let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array))fail('invalid_object_body');
      size+=value.byteLength;
      try { consume(value.byteLength); } catch(error) {await cancel(reader);throw error;}
      if(size>limit) {await cancel(reader);fail('object_byte_budget');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  if(size!==object.size)fail('object_size_mismatch');
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return {text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),sha256:digest(bytes)};
}
/** Capture only get/list capabilities. No arbitrary path, write, delete or upstream capability escapes. */
export function observationStore(bucket,instances,cutoff,overrides={}) {
  const limits=readLimits(overrides),before=instant(cutoff);
  if(!Array.isArray(instances)||!instances.length||instances.length>limits.maxInstances
    ||new Set(instances).size!==instances.length)fail('invalid_instances');
  const prefixes=new Map(instances.map(instance=>[instance,instancePrefix(instance)]));
  if(typeof bucket?.get!=='function'||typeof bucket?.list!=='function')fail('invalid_read_adapter');
  const get=bucket.get.bind(bucket),list=bucket.list.bind(bucket),cache=new Map(),receipts=[];
  let pages=0,requests=0,reads=0,bytes=0;
  function allowed(key) {
    if(typeof key!=='string')fail('invalid_object_key');
    for(const prefix of prefixes.values()) {
      if(key===prefix+'live-manifest.json')return;
      if(key.startsWith(prefix) && /^(?:requests\/(?:issue-detail|issue-pricing|bond-placement)\/|contents\/)[a-f0-9]{64}\.json$/.test(key.slice(prefix.length)))return;
    }
    fail('object_outside_declared_instances');
  }
  async function listRequests(instance) {
    const prefix=prefixes.get(instance);if(!prefix)fail('undeclared_instance');
    const rows=[],seenKeys=new Set(),seenCursors=new Set();let cursor;
    do {
      if(++pages>limits.maxPages)fail('page_budget');
      const result=await list({prefix:prefix+'requests/',limit:limits.pageSize,...(cursor?{cursor}:{})});
      if(!result || !Array.isArray(result.objects)||typeof result.truncated!=='boolean'
        ||result.objects.length>limits.pageSize)fail('invalid_list_page');
      for(const object of result.objects) {
        allowed(object?.key);
        if(!object.key.startsWith(prefix+'requests/')||seenKeys.has(object.key))fail('invalid_list_identity');
        seenKeys.add(object.key);if(++requests>limits.maxRequests)fail('request_budget');
        rows.push(metadata(object,object.key));
      }
      if(result.truncated) {
        if(typeof result.cursor!=='string'||!result.cursor||seenCursors.has(result.cursor))fail('invalid_list_cursor');
        seenCursors.add(result.cursor);cursor=result.cursor;
      } else cursor=undefined;
    } while(cursor);
    return rows.sort((a,b)=>a.key.localeCompare(b.key));
  }
  async function read(key,expected) {
    allowed(key);
    if(cache.has(key)) {
      const saved=cache.get(key);
      if(expected&&identity(saved.metadata)!==identity(expected))fail('object_changed_during_capture');
      return saved;
    }
    if(expected&&instant(expected.uploaded)>=before)return {excluded:'object_at_or_after_cutoff',metadata:expected};
    if(bytes>=limits.maxBytes)fail('total_byte_budget');
    if(++reads>limits.maxReads)fail('read_budget');
    const object=await get(key);
    if(!object)return {excluded:'missing_object'};
    const meta=metadata(object,key);
    if(expected&&identity(meta)!==identity(expected)) {
      await cancel(object.body);fail('object_changed_during_capture');
    }
    if(instant(meta.uploaded)>=before) {
      await cancel(object.body);return {excluded:'object_at_or_after_cutoff',metadata:meta};
    }
    if(meta.size>limits.maxObjectBytes||bytes+meta.size>limits.maxBytes) {
      await cancel(object.body);fail('total_byte_budget');
    }
    const body=await boundedBody(object,limits.maxObjectBytes,length=>{
      bytes+=length;if(bytes>limits.maxBytes)fail('total_byte_budget');
    });
    const saved={bytes:body.text,sha256:body.sha256,metadata:meta};cache.set(key,saved);
    receipts.push({...meta,sha256:body.sha256});
    return saved;
  }
  return Object.freeze({listRequests,read,receipts:()=>receipts.map(meta=>({...meta})),
    usage:()=>({pages,requests,reads,bytes}),limits});
}
