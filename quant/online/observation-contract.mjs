// Consumer of Data's issuance-observation schema v1; no source query or mutation.
import { createHash } from 'node:crypto';

export const PREFIX = 'data-observations/bond-issuance/';
export const FIELDS = Object.freeze({
  'issue-detail': ['SECUCODE','BOND_NAME_ABBR','BOND_TYPE','ISSUE_DATE','ACTUAL_ISSUE_SCALE',
    'BOND_EXPIRE_YEAR','ISSUERATE_REFERENCE','PAYPERYEAR','TOMRTY_YEAR','DEC_TOMRTYYEAR1',
    'ISSUER_RATING','BOND_RATING','IS_OEB','IS_GUARANTEE','PI_RATE_TYPE','ISSUER_NAME','ORGFORM'].sort(),
  'issue-pricing': ['TENDERDATE','TENDERFINALCOUPON','ISSCORPCREDITRAT','TENDERANNCDATE'].sort(),
  'bond-placement': ['RAISEWAY','MATURITYDATE'].sort(),
});
const SOURCES = Object.keys(FIELDS);
Object.values(FIELDS).forEach(fields=>Object.freeze(fields));
const own = (value,key) => Object.hasOwn(value,key);
export const canonical = value => JSON.stringify(value, (_key,v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])) : v);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => canonical(a) === canonical(b);
function require(condition,message) { if (!condition) throw new Error(message); }
function keys(value,expected) {
  require(value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(),[...expected].sort()),'Unexpected observation schema');
}
export function instancePrefix(instance) {
  require(typeof instance === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(instance),'Invalid observation instance');
  return PREFIX+instance+'/';
}
export function sourceDate(value) {
  if (typeof value !== 'string') return null;
  const short=value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const date=/^\d{8}$/.test(value) ? value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6)
    : short ? short[1]+'-'+short[2].padStart(2,'0')+'-'+short[3].padStart(2,'0')
    : value.slice(0,10).replaceAll('/','-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time=new Date(date+'T00:00:00Z');
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0,10)===date ? date : null;
}
export const canonicalDate = value => typeof value==='string' && sourceDate(value)===value;
const pricingDate = value => /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.test(String(value??''))
  ? sourceDate(String(value)) : null;
export function instant(value) {
  require(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    'Explicit ISO timestamp with timezone required');
  require(sourceDate(value.slice(0,10))!==null && Number(value.slice(11,13))<24
    && Number(value.slice(14,16))<60 && Number(value.slice(17,19))<60
    && (value.endsWith('Z') || (Number(value.slice(-5,-3))<24 && Number(value.slice(-2))<60)),
    'Invalid timestamp');
  const time=Date.parse(value); require(Number.isFinite(time),'Invalid timestamp'); return time;
}
export function validateRequest(request) {
  keys(request,['source','path','parameters','bonds']);
  require(SOURCES.includes(request.source),'Unknown observation source');
  const detail=request.source==='issue-detail', params=request.parameters;
  require(request.path===(detail?'/choice/ctr':'/choice/css'),'Observation path mismatch');
  require(params && typeof params==='object' && !Array.isArray(params),'Invalid parameters');
  const allowed=detail?['reportName','indicators','options']:['codes','indicators','options'];
  require(Object.entries(params).every(([key,value])=>allowed.includes(key)
    && typeof value==='string' && value.length<=16000),'Invalid finite parameters');
  require(params.indicators===FIELDS[request.source].join(','),'Indicator registry mismatch');
  require(!detail || params.reportName==='BondIssueDetail','Report source mismatch');
  require(Array.isArray(request.bonds),'Invalid bond context');
  const codes=detail?[]:(params.codes??'').split(',');
  require(detail || (codes.length>0 && codes.every(code=>/^[A-Z0-9._-]{1,64}$/.test(code))
    && new Set(codes).size===codes.length && same(codes,[...codes].sort())),'Invalid requested codes');
  const bonds=request.bonds;
  bonds.forEach(bond=>{ keys(bond,['code','date']); require(codes.includes(bond.code)
    && canonicalDate(bond.date),'Invalid original issuance context'); });
  require(bonds.length===codes.length && new Set(bonds.map(bond=>bond.code)).size===codes.length
    && same(bonds,[...bonds].sort((a,b)=>a.code.localeCompare(b.code))),'Incomplete issuance context');
  return request;
}
export function requestKey(instance,request) {
  return instancePrefix(instance)+'requests/'+request.source+'/'+digest(canonical(request))+'.json';
}
export function quality(request,payload) {
  const requested=request.parameters.codes?.split(',')??[], returned=[];
  const rows=payload.rows.map(row=>{
    const code=String(row[request.source==='issue-detail'?'SECUCODE':'code']??'').toUpperCase();
    returned.push(code);
    const fields=payload.fields.map(field=>({field,state:!own(row,field)?'absent':row[field]===null?'null'
      :['','--','—'].includes(String(row[field]))?'empty':'value'}));
    const date=request.bonds.find(bond=>bond.code===code)?.date,tender=pricingDate(row.TENDERDATE);
    const quarantined=request.source==='issue-pricing' && row.TENDERDATE!=null && row.TENDERDATE!==''
      && (!tender || !date || tender>date);
    return {code,fields,quarantined,unexpected_code:!code || (requested.length>0&&!requested.includes(code))};
  });
  return {requested_codes:requested,returned_codes:returned,missing_codes:requested.filter(code=>!returned.includes(code)),
    duplicate_codes:[...new Set(returned.filter((code,index)=>returned.indexOf(code)!==index))],rows};
}
function validateContent(content,request) {
  if(content.kind==='response') {
    keys(content,['kind','payload']); const payload=content.payload;keys(payload,['function','fields','rows']);
    require(payload.function===(request.source==='issue-detail'?'CTR':'CSS')
      && same(payload.fields,FIELDS[request.source]) && Array.isArray(payload.rows) && payload.rows.length<=20000,
      'Invalid finite response');
    const allowed=[...payload.fields,request.source==='issue-detail'?'SECUCODE':'code'];
    payload.rows.forEach(row=>require(row && typeof row==='object' && !Array.isArray(row)
      && Object.entries(row).every(([key,value])=>allowed.includes(key) &&
        (value===null || typeof value==='string' || typeof value==='boolean'
          || (typeof value==='number' && Number.isFinite(value)))),'Invalid response scalar'));
  } else {
    keys(content,['kind','error_code']);
    const errors={invalid_code:10003008,no_data:10000009,source_error:null,invalid_response:null};
    require(own(errors,content.kind) && content.error_code===errors[content.kind],'Invalid failure category');
  }
}
export function observationContentKey(instance,key,record) {
  keys(record,['schema_version','instance_id','scheduled_date','request','request_sha256',
    'content_key','content_sha256','response_received_at','observed_at','archived_at','final_coupon_published_at','quality']);
  const request=validateRequest(record.request), prefix=instancePrefix(instance);
  require(record.schema_version===1 && record.instance_id===instance && record.final_coupon_published_at===null
    && canonicalDate(record.scheduled_date) && key===requestKey(instance,request)
    && record.request_sha256===digest(canonical(request)) && /^[a-f0-9]{64}$/.test(record.content_sha256)
    && record.content_key===prefix+'contents/'+record.content_sha256+'.json','Observation provenance mismatch');
  require(instant(record.response_received_at)<=instant(record.archived_at),'Observation time mismatch');
  return record.content_key;
}
export function validateObservation(instance,key,record,contentBytes,rawSha256=digest(contentBytes)) {
  observationContentKey(instance,key,record);
  const request=record.request;
  require(rawSha256===record.content_sha256 && digest(contentBytes)===rawSha256,'Observation content checksum mismatch');
  const content=JSON.parse(contentBytes);validateContent(content,request);
  require(content.kind==='response' ? record.observed_at===record.response_received_at
    && same(record.quality,quality(request,content.payload)) : record.observed_at===null&&record.quality===null,
    'Observation quality mismatch');
  return {key,record,content};
}
export function validateManifest(instance,value) {
  keys(value,['schema_version','instance_id','requests']);
  require(value.schema_version===1 && value.instance_id===instance && Array.isArray(value.requests)
    && value.requests.length<=4096,'Invalid observation manifest');
  const prefix=instancePrefix(instance);
  value.requests.forEach(row=>{
    keys(row,['key','source','status','outcome']);
    require(SOURCES.includes(row.source) && ['archived','failed'].includes(row.status)
      && ['response','invalid_code','no_data','source_error','invalid_response'].includes(row.outcome)
      && typeof row.key==='string' && row.key.startsWith(prefix+'requests/'+row.source+'/')
      && /^[a-f0-9]{64}\.json$/.test(row.key.slice((prefix+'requests/'+row.source+'/').length)),'Invalid manifest request');
  });
  require(new Set(value.requests.map(row=>row.key)).size===value.requests.length,'Duplicate manifest request');
  return value;
}
