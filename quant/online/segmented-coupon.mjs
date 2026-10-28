import { scanInputSegment } from './input-segments.mjs';
import { projectInputRows, rawQuoteMarket, rawQuoteCodes, rawQuoteRatingIndex, buildRawQuoteContext, restoreRawQuoteContext, validateRawQuoteDependencies } from './raw-quote-context.mjs';
import { inferContext, issuanceRequest } from './issuance.mjs';
import { calendar, validateIndustryProfile } from './issuance-features.mjs';
const options={retries:{limit:0,delay:'1 second'}};
const width=32*1024,batchParts=24,protocol='coupon-segments-v2';
const childId=async(parent,index,io)=>`${(await io.sha256(new TextEncoder().encode(parent+protocol))).slice(0,20)}-segments-${index}`;
const batchKey=(prefix,index)=>`${prefix}/${protocol}/batch-${index}.json`;
async function writeIndex(env,key,value,io) {
  await io.putJson(env.ARTIFACTS,key,value);
  const object=await env.ARTIFACTS.head(key);
  if(!object?.customMetadata?.sha256)throw Error('Segment artifact checksum missing');
  if(object.customMetadata.sha256!==await io.sha256(new TextEncoder().encode(JSON.stringify(value))))throw Error('Immutable segment artifact differs');
  return {key,sha256:object.customMetadata.sha256};
}
async function loadGroups(env,indexes,names,io) {
  const datasets=Object.fromEntries(names.map(name=>[name,[]]));
  for(const index of indexes)for(const group of index.groups){
    if(!names.includes(group.name))continue;
    const rows=await io.readJson(env.ARTIFACTS,group.key,16*1024*1024,group.sha256);
    datasets[group.name].push(...rows);
  }
  return datasets;
}
export async function couponInputBatch(env,step,event,io) {
  const task=event.payload.input_batch;
  if(!task||!Number.isInteger(task.index)||task.index<0||task.index>50
    ||!Number.isInteger(task.start)||!Number.isInteger(task.end)||task.start<0||task.end<=task.start||task.end>task.input?.size||task.end-task.start>width*batchParts
    ||task.input.key!==`${task.parent_prefix}/inputs.json`
    ||!/^quant-trial\/runs\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,100}$/.test(task.parent_prefix)
    ||task.parent_prefix!==`quant-trial/runs/${event.payload.as_of_date}/${task.parent_id}`
    ||event.instanceId!==await childId(task.parent_id,task.index,io))throw Error('Invalid coupon input batch');
  const initial=await step.do('restore-input-checkpoint',options,async()=>{
    if(!task.previous){if(task.start!==0||task.index!==0)throw Error('Missing preceding input checkpoint');return {};}
    const prior=await io.readJson(env.ARTIFACTS,task.previous.key,128*1024,task.previous.sha256);
    if(prior.protocol!==protocol||prior.parent_id!==task.parent_id||prior.index!==task.index-1
      ||prior.to!==task.start||prior.input_sha256!==task.input.sha256||prior.model_version!==task.model_version
      ||JSON.stringify(prior.terms)!==JSON.stringify(task.terms))throw Error('Discontinuous input checkpoint');
    return prior.checkpoint;
  });
  let scanner=initial.scanner,projection=initial.projection;
  const datasets={},segments=[];
  for(let offset=task.start;offset<task.end;offset+=width){
    const part=await step.do(`read-input-part-${offset}`,options,async()=>{
      const object=await env.ARTIFACTS.get(task.input.key,{range:{offset,length:Math.min(width,task.end-offset)},onlyIf:{etagMatches:task.input.etag}});
      if(!object?.body)throw Error('Frozen input changed during segmented inference');
      const bytes=new Uint8Array(await object.arrayBuffer());
      if(bytes.length!==Math.min(width,task.end-offset))throw Error('Truncated frozen input range');
      const parsed=scanInputSegment(scanner,bytes,offset+bytes.length===task.input.size);
      const projected=projectInputRows(parsed.rows,event.payload.as_of_date,task.terms,projection);
      return {scanner:parsed.state,projection:projected.state,datasets:projected.datasets,offset,bytes:bytes.length,sha256:await io.sha256(bytes)};
    });
    scanner=part.scanner;projection=part.projection;
    segments.push({offset:part.offset,bytes:part.bytes,sha256:part.sha256});
    for(const[group,rows]of Object.entries(part.datasets))(datasets[group]??=[]).push(...rows);
  }
  const artifact=await step.do('archive-input-batch',options,async()=>{
    const groups=[];
    for(const[name,rows]of Object.entries(datasets))groups.push({name,...await writeIndex(env,`${task.parent_prefix}/${protocol}/batch-${task.index}-${name}.json`,rows,io)});
    return writeIndex(env,batchKey(task.parent_prefix,task.index),{protocol,parent_id:task.parent_id,child_id:event.instanceId,index:task.index,
      from:task.start,to:task.end,input_sha256:task.input.sha256,model_version:task.model_version,terms:task.terms,checkpoint:{scanner,projection},groups,segments},io);
  });
  await step.do('notify-input-parent',options,async()=>{
    const parent=await env.INFERENCE.get(task.parent_id);
    await parent.sendEvent({type:`coupon-batch-${task.index}`,payload:{...artifact,parent_id:task.parent_id,child_id:event.instanceId,index:task.index}});
  });
  return artifact;
}
export async function segmentedCoupon(env,step,manifest,model,event,runPrefix,io) {
  validateRawQuoteDependencies(model);
  const {terms}=issuanceRequest(manifest,event.payload),inputKey=`${runPrefix}/inputs.json`,asOf=event.payload.as_of_date??runPrefix.split('/')[2];
  const input=await step.do('verify-frozen-input-stream',options,async()=>{
    const object=await env.ARTIFACTS.get(inputKey);
    if(!object||object.size>32*1024*1024||!object.customMetadata?.sha256)throw Error('Invalid frozen input');
    const digest=new crypto.DigestStream('SHA-256');await object.body.pipeTo(digest);
    const hash=Array.from(new Uint8Array(await digest.digest),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==object.customMetadata.sha256)throw Error('Frozen input checksum mismatch');
    return {key:inputKey,size:object.size,etag:object.etag,sha256:hash};
  });
  const indexes=[];let previous;
  for(let start=0,index=0;start<input.size;start+=width*batchParts,index++){
    const end=Math.min(input.size,start+width*batchParts);
    const dispatched=await step.do(`start-input-batch-${index}`,options,async()=>{
      const id=await childId(event.instanceId,index,io);
      const params={as_of_date:asOf,input_batch:{parent_id:event.instanceId,parent_prefix:runPrefix,index,start,end,input,terms,previous,model_version:manifest.model_version}};
      try{await env.INFERENCE.create({id,params});return {id,complete:false};}
      catch(error){const existing=await env.INFERENCE.get(id);const status=await existing.status();if(['errored','terminated'].includes(status.status))throw error;return {id,complete:status.status==='complete'};}
    });
    const notice=dispatched.complete?{key:batchKey(runPrefix,index)}:(await step.waitForEvent(`input-batch-${index}`,{type:`coupon-batch-${index}`,timeout:'5 minutes'})).payload;
    const accepted=await step.do(`accept-input-batch-${index}`,options,async()=>{
      if(!dispatched.complete&&(notice.parent_id!==event.instanceId||notice.child_id!==dispatched.id||notice.index!==index))throw Error('Input batch notification identity mismatch');
      if(notice.error)throw Error('Coupon input child failed: '+dispatched.id);
      if(notice.key!==batchKey(runPrefix,index))throw Error('Wrong input batch artifact');
      const result=await io.readJson(env.ARTIFACTS,notice.key,128*1024,notice.sha256);
      if(result.protocol!==protocol||result.parent_id!==event.instanceId||result.child_id!==dispatched.id||result.index!==index
        ||result.from!==start||result.to!==end||result.input_sha256!==input.sha256||result.model_version!==manifest.model_version
        ||JSON.stringify(result.terms)!==JSON.stringify(terms))throw Error('Input batch identity mismatch');
      const object=await env.ARTIFACTS.head(notice.key);
      return {result,reference:{key:notice.key,sha256:object.customMetadata.sha256}};
    });
    indexes.push(accepted.result);previous=accepted.reference;
  }
  const scanner=indexes.at(-1).checkpoint.scanner,date=scanner.meta.as_of_date;
  if(scanner.phase!=='done'||date!==asOf||scanner.meta.issuance_scope!==manifest.issuance_scope)throw Error('Frozen input identity mismatch');
  validateIndustryProfile(scanner.meta.industry_source_profile);
  for(const group of manifest.required_input_groups)if(!scanner.counts[group])throw Error(`Unavailable ${group} inputs`);
  const market=await step.do('prepare-treasury-quote-clock',options,async()=>{
    const datasets=await loadGroups(env,indexes,['funding','industry_curve'],io),prior=calendar(manifest.calendar).previous(date);
    if(!datasets.industry_curve.some(row=>row.observation_date===prior&&Number.isFinite(Number(row.yield_pct))))throw Error('Stale market quote');
    return rawQuoteMarket(scanner.meta,datasets);
  });
  const codeIndex=await step.do('prepare-coupon-code-index',options,async()=>{
    const datasets=await loadGroups(env,indexes,['bond_issuance'],io);
    return {input_sha256:input.sha256,scope:manifest.issuance_scope,codes:rawQuoteCodes(datasets.bond_issuance,manifest.issuance_scope)};
  });
  const ratings=await step.do('prepare-coupon-rating-index',options,async()=>{
    if(codeIndex.input_sha256!==input.sha256||codeIndex.scope!==manifest.issuance_scope)throw Error('Coupon code index identity mismatch');
    const datasets=await loadGroups(env,indexes,['issue'],io);
    return [...rawQuoteRatingIndex(datasets.issue,codeIndex.codes)];
  });
  const contextKey=await step.do('prepare-raw-quote-context',options,async()=>{
    const datasets=await loadGroups(env,indexes,['bond_issuance','issuer_daily','industry_nodes'],io);
    const context=buildRawQuoteContext(scanner.meta,{...datasets,issue:[]},manifest,{market,ratings:new Map(ratings)});
    await io.putJson(env.ARTIFACTS,`${runPrefix}/input-segments.json`,{protocol,input_sha256:input.sha256,bytes:input.size,groups:scanner.counts,batches:indexes.map(({checkpoint,...record})=>record)});
    return io.putJson(env.ARTIFACTS,`${runPrefix}/quote-context.json`,{input_sha256:input.sha256,model_version:manifest.model_version,context});
  });
  return step.do('predict-segmented-coupon',options,async()=>{
    const prepared=await io.readJson(env.ARTIFACTS,contextKey);
    if(prepared.input_sha256!==input.sha256||prepared.model_version!==manifest.model_version)throw Error('Prepared coupon context identity mismatch');
    const result=inferContext(manifest,date,model,restoreRawQuoteContext(prepared.context),event.payload);
    Object.assign(result.online_run,{runtime:'cloudflare-workflow',input_prefix:runPrefix,workflow_id:event.instanceId,input_sha256:input.sha256,input_segments:Math.ceil(input.size/width),input_batches:indexes.length});
    return io.putJson(env.ARTIFACTS,`${runPrefix}/result.json`,result);
  });
}
