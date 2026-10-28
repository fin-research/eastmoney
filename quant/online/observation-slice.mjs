import { canonical, canonicalDate, digest, FIELDS, instant, instancePrefix, sourceDate,
  observationContentKey, validateObservation, validateManifest } from './observation-contract.mjs';
import { observationStore, ObservationStoreError } from './observation-store.mjs';

function budget(error) { if(error instanceof ObservationStoreError&&error.code.endsWith('_budget'))throw error; }
function decode(bytes) {
  const value=JSON.parse(bytes);
  if(canonical(value)!==bytes)throw new Error('Noncanonical owner object');
  return value;
}
function provenance(observation) {
  const {record,recordMetadata,contentMetadata}=observation;
  return {instance_id:record.instance_id,record_key:observation.key,request_sha256:record.request_sha256,
    content_key:record.content_key,content_sha256:record.content_sha256,
    observed_at:observation.content.kind==='unavailable'?null:record.observed_at,
    claimed_observed_at:record.observed_at,
    response_received_at:record.response_received_at,archived_at:record.archived_at,
    record_uploaded_at:recordMetadata.uploaded,content_uploaded_at:contentMetadata?.uploaded??null,
    record_etag:recordMetadata.etag,content_etag:contentMetadata?.etag??null,
    record_version:recordMetadata.version,content_version:contentMetadata?.version??null,
    first_publication_at:null};
}
async function loadInstance(store,instance,before) {
  const prefix=instancePrefix(instance),issues=[],observations=[],outcomes=[];
  let manifest=null,manifestReason=null,manifestMetadata=null;
  try {
    const object=await store.read(prefix+'live-manifest.json');
    manifestMetadata=object.metadata??null;
    if(object.excluded)manifestReason=object.excluded;
    else manifest=validateManifest(instance,decode(object.bytes));
  } catch(error) {budget(error);manifestReason='invalid_manifest';}
  const listed=await store.listRequests(instance);
  for(const meta of listed) {
    let trusted=null,mappingMetadata=null;
    const unavailable=(reason,contentMetadata=null)=>{
      observations.push({key:meta.key,record:trusted,content:{kind:'unavailable',reason},
        recordMetadata:mappingMetadata,contentMetadata});
    };
    try {
      const mapping=await store.read(meta.key,meta);
      if(mapping.excluded){issues.push({key:meta.key,reason:mapping.excluded,metadata:mapping.metadata??null});continue;}
      const record=decode(mapping.bytes),contentKey=observationContentKey(instance,meta.key,record);
      if(instant(record.response_received_at)>=before){issues.push({key:meta.key,reason:'response_at_or_after_cutoff',
        response_received_at:record.response_received_at,metadata:mapping.metadata});continue;}
      trusted=record;mappingMetadata=mapping.metadata;
      const body=await store.read(contentKey);
      if(body.excluded){issues.push({key:meta.key,content_key:contentKey,reason:body.excluded,metadata:body.metadata??null});
        unavailable(body.excluded,body.metadata??null);continue;}
      const observation=validateObservation(instance,meta.key,record,body.bytes,body.sha256);
      // The SHA binds exact owner bytes; independently reject noncanonical JSON.
      decode(body.bytes);
      observations.push({...observation,recordMetadata:mapping.metadata,contentMetadata:body.metadata});
      outcomes.push({key:meta.key,source:record.request.source,outcome:observation.content.kind});
    } catch(error) {
      budget(error);issues.push({key:meta.key,reason:error instanceof ObservationStoreError?error.code:'invalid_observation'});
      if(trusted)unavailable('invalid_observation');
    }
  }
  const byKey=new Map(outcomes.map(row=>[row.key,row]));
  let requestCoverage=manifest?'complete':'unknown';
  if(manifest) {
    for(const item of manifest.requests) {
      const observed=byKey.get(item.key);
      if(item.status==='failed') {
        issues.push({key:item.key,reason:'declared_archive_failure'});
        if(requestCoverage==='complete')requestCoverage='partial';
      } else if(!observed||observed.source!==item.source||observed.outcome!==item.outcome) {
        issues.push({key:item.key,reason:'manifest_record_unverified'});requestCoverage='unknown';
      }
    }
    if(listed.some(row=>!manifest.requests.some(item=>item.key===row.key)))requestCoverage='unknown';
  }
  if(manifestReason)issues.push({key:prefix+'live-manifest.json',reason:manifestReason,metadata:manifestMetadata});
  return {instance,requestCoverage,observations,issues,outcomes,
    manifest_sha256:manifest?digest(canonical(manifest)):null,manifest_metadata:manifestMetadata};
}
function splitParent(observation,observations) {
  const request=observation.record.request;
  if(observation.content.kind!=='invalid_code'||request.bonds.length<2)return false;
  const covered=new Set(),parameters=r=>canonical({...r.parameters,codes:''});
  for(const child of observations) {
    const r=child.record.request;
    if(child.record.instance_id!==observation.record.instance_id||r.source!==request.source||r.bonds.length>=request.bonds.length
      ||parameters(r)!==parameters(request)||instant(child.record.response_received_at)<instant(observation.record.response_received_at)
      ||r.bonds.some(bond=>!request.bonds.some(parent=>parent.code===bond.code&&parent.date===bond.date)))continue;
    if(child.content.kind==='response'||(child.content.kind==='invalid_code'&&r.bonds.length===1))
      r.bonds.forEach(bond=>covered.add(bond.code));
  }
  return request.bonds.every(bond=>covered.has(bond.code));
}
function responseFields(observation,emit,expected) {
  const {record,content}=observation,request=record.request,fields=FIELDS[request.source],origin=provenance(observation);
  const detail=request.source==='issue-detail',rows=content.payload.rows;
  const codes=detail?rows.map(row=>String(row.SECUCODE??'').toUpperCase()):request.bonds.map(bond=>bond.code);
  for(const code of codes) {
    if(expected&&!expected.has(code))continue;
    const row=rows.find(row=>String(row[detail?'SECUCODE':'code']??'').toUpperCase()===code);
    const audit=record.quality.rows.find(row=>row.code===code);
    const context=detail?sourceDate(row?.ISSUE_DATE):request.bonds.find(bond=>bond.code===code).date;
    const contextState=!context?'context_missing':expected&&expected.get(code)!==context?'context_mismatch':null;
    for(const field of fields) {
      const state=contextState??(!row?'missing_code':audit.quarantined?'quarantined':
        audit.fields.find(item=>item.field===field).state);
      emit({source:request.source,code,field,state,value:state==='value'?row[field]:null,
        issuance_date_context:context,provenance:origin});
    }
  }
}
function failedFields(observation,emit,expected,failure=observation.content.kind) {
  const {record}=observation,request=record.request;
  for(const bond of request.bonds) {
    if(expected&&!expected.has(bond.code))continue;
    for(const field of FIELDS[request.source])emit({source:request.source,code:bond.code,field,
      state:expected&&expected.get(bond.code)!==bond.date?'context_mismatch':
        observation.content.kind==='unavailable'?'unavailable':'failed',value:null,
      failure,issuance_date_context:bond.date,provenance:provenance(observation)});
  }
}
function selectFields(observations,limit,expected) {
  const selected=new Map(),lastKnown=new Map(),issues=[],sourceBarriers=[];let count=0;
  function barrier(observation,reason,presentCodes=null) {
    if(observation.record.request.source!=='issue-detail')return;
    const options=observation.record.request.parameters.options??'';
    const start=sourceDate(options.match(/(?:^|,)StartDate=([^,]+)/)?.[1]);
    const end=sourceDate(options.match(/(?:^|,)EndDate=([^,]+)/)?.[1]);
    sourceBarriers.push({source:'issue-detail',at:observation.record.response_received_at,
      range:start&&end&&start<=end?{start,end}:null,present_codes:presentCodes,
      reason,provenance:provenance(observation)});
  }
  function emit(candidate) {
    if(++count>limit)throw new ObservationStoreError('field_budget');
    const key=canonical([candidate.source,candidate.code,candidate.field]),time=instant(candidate.provenance.response_received_at);
    if(candidate.state==='value') {
      const known=lastKnown.get(key);
      if(!known||time>known.time)lastKnown.set(key,{time,candidate});
      else if(time===known.time&&canonical([known.candidate.value,known.candidate.issuance_date_context])
        !==canonical([candidate.value,candidate.issuance_date_context]))
        lastKnown.set(key,{time,candidate:{...known.candidate,state:'ambiguous',value:null}});
    }
    const previous=selected.get(key);
    if(!previous||time>previous.time)selected.set(key,{time,candidates:[candidate]});
    else if(time===previous.time)previous.candidates.push(candidate);
  }
  for(const observation of observations) {
    if(splitParent(observation,observations)){issues.push({key:observation.key,reason:'resolved_split_parent'});continue;}
    if(observation.content.kind!=='response') {
      if(observation.content.kind!=='no_data'||observation.record.request.source!=='issue-detail')
        issues.push({key:observation.key,reason:'failed_source',outcome:observation.content.kind});
      barrier(observation,observation.content.reason??observation.content.kind);
      failedFields(observation,emit,expected,observation.content.reason??observation.content.kind);continue;
    }
    const quality=observation.record.quality;
    if(quality.duplicate_codes.length||quality.rows.some(row=>row.unexpected_code)) {
      issues.push({key:observation.key,reason:'invalid_response_codes'});
      barrier(observation,'invalid_response_codes');
      failedFields(observation,emit,expected,'invalid_response_codes');continue;
    }
    if(observation.record.request.source==='issue-detail')barrier(observation,'code_not_in_latest_response',quality.returned_codes);
    responseFields(observation,emit,expected);
  }
  const fields=[...selected].map(([key,{candidates}])=>{
    candidates.sort((a,b)=>a.provenance.record_key.localeCompare(b.provenance.record_key));
    const same=new Set(candidates.map(({state,value,issuance_date_context,failure})=>
      canonical({state,value,issuance_date_context,...(failure?{failure}:{})}))).size===1;
    const chosen=candidates[0];
    const field={...chosen,...(!same?{state:'ambiguous',value:null}:{}),
      observation_keys:[...new Set(candidates.map(row=>row.provenance.record_key))]};
    if(field.state!=='value'&&lastKnown.has(key))field.last_known_observation=lastKnown.get(key).candidate;
    return field;
  }).sort((a,b)=>canonical([a.source,a.code,a.field]).localeCompare(canonical([b.source,b.code,b.field])));
  for(const field of fields) {
    const applicable=sourceBarriers.filter(item=>item.source===field.source
      && (!item.present_codes||!item.present_codes.includes(field.code))
      && (!item.range||!field.issuance_date_context
        ||(item.range.start<=field.issuance_date_context&&field.issuance_date_context<=item.range.end))
      && instant(item.at)>=instant(field.provenance.response_received_at));
    if(!applicable.length)continue;
    const latest=applicable.sort((a,b)=>instant(b.at)-instant(a.at))[0];
    field.raw_observation={...field};field.state=instant(latest.at)===instant(field.provenance.response_received_at)
      ?'ambiguous':'source_unavailable';field.value=null;field.barrier=latest;
    if(!field.last_known_observation&&field.raw_observation.state==='value')field.last_known_observation=field.raw_observation;
  }
  return {fields,issues,sourceBarriers,field_candidates:count};
}
function expectedContext(bonds) {
  if(bonds===undefined)return null;
  if(!Array.isArray(bonds)||!bonds.length||bonds.length>4096
    ||bonds.some(bond=>!bond||typeof bond.code!=='string'||!/^[A-Z0-9._-]{1,64}$/.test(bond.code)
      ||!canonicalDate(bond.date))||new Set(bonds.map(bond=>bond.code)).size!==bonds.length)
    throw new Error('Invalid expected bond context');
  return new Map(bonds.map(bond=>[bond.code,bond.date]));
}
/** A bounded field-observation slice, deliberately not a training panel or publication-time reconstruction. */
export async function readIssuanceObservationSlice(bucket,{instances,cutoff,bonds,limits}={}) {
  const before=instant(cutoff),expected=expectedContext(bonds),store=observationStore(bucket,instances,cutoff,limits);
  const runs=[];
  for(const instance of [...instances].sort())runs.push(await loadInstance(store,instance,before));
  const observations=runs.flatMap(run=>run.observations);
  const selected=selectFields(observations,store.limits.maxFields,expected);
  const issues=[...runs.flatMap(run=>run.issues),...selected.issues];
  const requestCoverage=runs.some(run=>run.requestCoverage==='unknown')?'unknown'
    :runs.some(run=>run.requestCoverage==='partial')?'partial':'complete';
  // An unverified request universe cannot establish a latest value. Retain facts for audit only.
  if(requestCoverage!=='complete')for(const field of selected.fields) {
    if(!field.raw_observation)field.raw_observation={...field};
    if(!field.last_known_observation&&field.raw_observation.state==='value')field.last_known_observation=field.raw_observation;
    field.state='availability_unknown';field.value=null;
  }
  const missingExpected=expected?[...expected].filter(([code])=>!selected.fields.some(row=>row.code===code)).map(([code,date])=>({code,date})):[];
  const fieldCoverage=selected.fields.some(row=>row.state!=='value')||missingExpected.length
    ||selected.issues.some(issue=>issue.reason!=='resolved_split_parent')?'partial'
    :selected.fields.length?'complete':'not_observed';
  return {schema_version:1,kind:'issuance-field-observation-slice',cutoff:new Date(before).toISOString(),
    scope:'only declared instances and finite source fields; not all bonds or full historical terms',
    selection_rule:'latest response_received_at; same-time conflicts are ambiguous; unverified request universe has no usable latest values',
    first_publication_known:false,metadata_origin:'provided R2 get/list metadata; runtime provenance requires separate verification',
    request_coverage:requestCoverage,field_coverage:fieldCoverage,
    status:requestCoverage==='complete'&&fieldCoverage==='complete'?'complete':'partial',
    instances:runs.map(({instance,requestCoverage,manifest_sha256,manifest_metadata})=>({instance,request_coverage:requestCoverage,
      manifest_sha256,manifest_metadata})),
    fields:selected.fields,missing_expected_bonds:missingExpected,issues,source_barriers:selected.sourceBarriers,
    request_outcomes:runs.flatMap(run=>run.outcomes),
    captured_objects:store.receipts(),usage:{...store.usage(),field_candidates:selected.field_candidates}};
}
