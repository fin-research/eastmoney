import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {WorkflowStep} from 'cloudflare:workers';
import type {DataApiRequest} from './economic-indicator-sync.ts';
import type {DatabaseClient} from './postgres.ts';
import {encodeExchangeBondCode} from './exchange-bond-code.ts';
import {requireBondBudget} from './bond-history-sync.ts';
import {workflowCssBudget} from './workflow-css-budget.ts';
import {CssResponseArchiveError, type DataResponseEvidence} from './css-response-evidence.ts';

export const FIELD_OBSERVATION_INSTANCE='bond-field-observation-20261026-20261023';
export const FIELD_OBSERVATION_PLAN_KEY=`data-observations/css-executions/${FIELD_OBSERVATION_INSTANCE}/plan.json`;
export const FIELD_OBSERVATION_PLAN_SHA='38a0dd119d6cfbd42782a756d2e02d5648d2ff4065e3fe7fdcbf99c8bf313f87';
const PREFIX=`data-observations/css-executions/${FIELD_OBSERVATION_INSTANCE}/`;
const STEP={retries:{limit:0,delay:'1 second'},timeout:'5 minutes'} as const;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const planSchema=z.object({version:z.literal(1),instanceId:z.literal(FIELD_OBSERVATION_INSTANCE),operationDate:z.literal('2026-10-26'),expiresAt:z.literal('2026-10-26T15:55:00.000Z'),observationDate:z.literal('2026-10-23'),
 codes:z.array(z.string()).length(83),fields:z.tuple([z.literal('YIELDCNBD'),z.literal('MATUCNBD')]),points:z.literal(166),sharedReserve:z.literal(100000),priorPlanSha256:digest,
 priorIntents:z.array(z.object({code:z.string(),intents:z.array(z.object({key:z.string(),bodySha256:digest})).min(1).max(23)})).length(83),
 relatedWorkflowIds:z.array(z.string()).length(5),expectedObjects:z.array(z.object({key:z.string(),etag:z.string(),size:z.number().int().nonnegative()})).length(137),
 quotaPeriod:z.object({start:z.literal('2026-10-26'),end:z.literal('2026-11-01')}),mode:z.literal('observe-only'),retries:z.literal(0),split:z.literal(0),databaseWrites:z.literal(0)}).strict();
type Plan=z.infer<typeof planSchema>;
type Database=<T>(operation:(client:DatabaseClient)=>Promise<T>)=>Promise<T>;
type Bucket=Pick<R2Bucket,'get'|'put'|'list'>;
function windowOpen(){if(new Date(Date.now()+8*3600000).toISOString().slice(0,10)!=='2026-10-26'||Date.now()>=Date.parse('2026-10-26T15:55:00.000Z'))throw Error('Field observation operation date expired');}
async function immutable(bucket:Bucket,key:string,value:unknown){
 const result=await bucket.put(key,JSON.stringify(value),{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/json'}});
 if(!result)throw Error('Field observation evidence exists; refusing replay');
}
async function planText(bucket:Bucket,approvedPlanSha:string){
 const object=await bucket.get(FIELD_OBSERVATION_PLAN_KEY);
 if(!object||object.size>64000)throw Error('Frozen field observation plan unavailable');
 const text=await object.text();if(sha(text)!==approvedPlanSha)throw Error('Frozen field observation plan SHA mismatch');
 return text;
}
export function parseFieldObservationPlan(text:string,approvedPlanSha=FIELD_OBSERVATION_PLAN_SHA){
 if(sha(text)!==approvedPlanSha)throw Error('Unapproved field observation matrix');
 const plan=planSchema.parse(JSON.parse(text));
 if(new Set(plan.codes).size!==83||JSON.stringify([...plan.codes].sort())!==JSON.stringify(plan.priorIntents.map(row=>row.code).sort()))throw Error('Field observation matrix changed');
 for(const code of plan.codes)encodeExchangeBondCode(code);
 return plan;
}
async function databaseScope(db:Database,plan:Plan){
 return db(async client=>{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await client.query("SET LOCAL statement_timeout='30000ms'");
   const result=await client.query<{code:string;date:string;chinabond_yield_pct:number|null;remaining_term_years:number|null;history_invalid_code:boolean;actual_issuance_status:string}>(`SELECT i.bond_code AS code,h.valuation_date::text AS date,h.chinabond_yield_pct,h.remaining_term_years,i.history_invalid_code,i.actual_issuance_status
    FROM public.bond_issuance i JOIN public.bond_history h ON h.bond_code=public.exchange_bond_code(i.bond_code)
    WHERE i.bond_code=ANY($1::text[]) AND h.valuation_date=$2::date ORDER BY i.bond_code`,[plan.codes,plan.observationDate]);
   if(result.rows.length!==83||new Set(result.rows.map(row=>row.code)).size!==83||JSON.stringify(result.rows.map(row=>row.code).sort())!==JSON.stringify([...plan.codes].sort())||
    result.rows.some(row=>row.date!==plan.observationDate||row.chinabond_yield_pct!==null||row.remaining_term_years!==null||row.history_invalid_code||row.actual_issuance_status==='not_issued'))throw Error('Exact field observation database scope changed');
   return sha(JSON.stringify(result.rows));
  }finally{await client.query('ROLLBACK');}
 });
}
async function inventory(bucket:Bucket,plan:Plan,afterQuota=false){
 const rows:Array<{key:string;etag:string;size:number}>=[],seen=new Set<string>();let cursor:string|undefined,hasPlan=false;
 for(let pageNumber=0;pageNumber<4;pageNumber++){
  const page=await bucket.list({prefix:'data-observations/',limit:1000,...(cursor?{cursor}:{})});
  for(const object of page.objects){
   if(seen.has(object.key))throw Error('Nonprogress field observation inventory');seen.add(object.key);
   if(object.key===FIELD_OBSERVATION_PLAN_KEY){hasPlan=true;continue;}
   if(afterQuota&&[PREFIX+'quota-attempt.json',PREFIX+'quota-response.json'].includes(object.key))continue;
   rows.push({key:object.key,etag:object.etag,size:object.size});
  }
  if(page.truncated&&!page.cursor)throw Error('Incomplete field observation intent inventory');
  if(!page.truncated){
   rows.sort((a,b)=>a.key.localeCompare(b.key));
   if(!hasPlan||JSON.stringify(rows)!==JSON.stringify(plan.expectedObjects))throw Error('Shared intent/archive inventory changed');
   return {objects:rows.length+1,sha256:sha(JSON.stringify(rows))};
  }
  cursor=page.cursor;
 }
 throw Error('Field observation inventory exceeds bounded scope');
}

async function freshQuotaEvidence(bucket:Bucket){
 const stored=await bucket.get(PREFIX+'quota-response.json');if(!stored||stored.size>64000)throw Error('Quota response evidence unavailable');
 const evidence=JSON.parse(await stored.text()) as DataResponseEvidence;
 const age=Date.now()-Date.parse(evidence.capturedAt);
 if(!evidence.complete||evidence.status!==200||evidence.redacted||!evidence.body||evidence.receivedBytes!==evidence.retainedBytes||evidence.retainedBytes!==new TextEncoder().encode(evidence.body).length||evidence.rawBodySha256!==evidence.retainedBodySha256||sha(evidence.body)!==evidence.retainedBodySha256||!Number.isFinite(age)||age<0||age>15*60000)throw Error('Quota response incomplete or expired');
 return evidence;
}

/** One explicit, frozen observation: no database writes, recursive isolation, or automatic source retries. */
export async function runBondFieldObservation(step:Pick<WorkflowStep,'do'>,env:Pick<Cloudflare.Env,'EASTMONEY'|'ECONOMIC_INDICATOR_SYNC'>,
 instanceId:string,key:string,request:DataApiRequest,db:Database,approvedPlanSha=FIELD_OBSERVATION_PLAN_SHA){
 if(instanceId!==FIELD_OBSERVATION_INSTANCE||key!==FIELD_OBSERVATION_PLAN_KEY)throw Error('Unapproved field observation instance/plan');
 const prepared=await step.do('核对冻结字段观察计划及只读缺口',STEP,async()=>{
  windowOpen();const plan=parseFieldObservationPlan(await planText(env.EASTMONEY,approvedPlanSha),approvedPlanSha);
  const databaseSha256=await databaseScope(db,plan);
  const workflows=await Promise.all(plan.relatedWorkflowIds.map(async id=>{
   const state=await(await env.ECONOMIC_INDICATOR_SYNC.get(id)).status();
   if(!['complete','errored','terminated'].includes(state.status))throw Error('Related Workflow still in flight');
   return {id,status:state.status};
  }));
  return {databaseSha256,workflows};
 });
 const inventoryProof=await step.do('完整核对字段观察共享意图库存',STEP,async()=>{
  windowOpen();const plan=JSON.parse(await planText(env.EASTMONEY,approvedPlanSha)) as Plan;return inventory(env.EASTMONEY,plan);
 });
 const quotaParameters=new URLSearchParams({funcName:'EM_CSS',indicators:'FUNCENAME,SECUTYPE,PERIOD,STARTDATE,ENDDATE,THRESHOLD,USEDDATA,AVAILABEDATA'});
 const evidenceRequest:DataApiRequest=async(path,parameters,capture)=>{
  if(path!=='/choice/data-statistics'){
   if(path!=='/choice/css')throw Error('Unapproved field observation source');
   await freshQuotaEvidence(env.EASTMONEY);windowOpen();
   return request(path,parameters,capture);
  }
  windowOpen();await planText(env.EASTMONEY,approvedPlanSha);
  await immutable(env.EASTMONEY,PREFIX+'quota-attempt.json',{instanceId,startedAt:new Date().toISOString(),planSha256:approvedPlanSha,parameters:[...parameters],limit:1});
  windowOpen();
  let captured=false;
  const result=await request(path,parameters,async evidence=>{
   await immutable(env.EASTMONEY,PREFIX+'quota-response.json',{version:1,parameters:[...parameters],...evidence,storedBodySha256:evidence.body===null?null:sha(evidence.body)});captured=true;
  });
  if(!captured)throw new CssResponseArchiveError();
  return result;
 };
 // Constructor starts the one persisted quota step only after both preparation steps completed.
 const budget=workflowCssBudget(step,env.EASTMONEY,instanceId,evidenceRequest,'2026-10-26',{history:166});
 // This reads the persisted quota result; it does not perform a second SDK request.
 const quota=await budget('history')('/choice/data-statistics',quotaParameters);
 return step.do('一次字段观察及完整响应归档',STEP,async()=>{
  windowOpen();const plan=JSON.parse(await planText(env.EASTMONEY,approvedPlanSha)) as Plan;
  if(await databaseScope(db,plan)!==prepared.databaseSha256)throw Error('Prepared database scope changed before observation');
  await inventory(env.EASTMONEY,plan,true);
  const evidence=await freshQuotaEvidence(env.EASTMONEY);
  requireBondBudget(quota,'2026-10-26',166);
  const row=(quota as {rows:Array<Record<string,unknown>>}).rows.find(row=>row.FUNCENAME==='EM_CSS'&&row.SECUTYPE==='全品种');
  if(row?.STARTDATE!==plan.quotaPeriod.start||row?.ENDDATE!==plan.quotaPeriod.end||row?.PERIOD!=='W')throw Error('Quota period changed');
  await immutable(env.EASTMONEY,PREFIX+'execution-manifest.json',{instanceId,planKey:key,planSha256:approvedPlanSha,databaseSha256:prepared.databaseSha256,inventory:inventoryProof,quotaRawBodySha256:evidence.rawBodySha256,priorIntents:plan.priorIntents,limits:{points:166,sharedReserve:100000,retries:0,split:0,databaseWrites:0}});
  const parameters=new URLSearchParams({codes:plan.codes.join(','),indicators:plan.fields.join(','),options:`EndDate=${plan.observationDate},CredType=1`});
  await budget('history')('/choice/css',parameters);
  const requestSha256=sha(JSON.stringify({path:'/choice/css',parameters:[...parameters].sort(([a],[b])=>a.localeCompare(b))}));
  return {status:'observed-only',instanceId,planSha256:approvedPlanSha,fields:166,databaseWrites:0,responseKey:`data-observations/css-responses/${instanceId}/history/${requestSha256}.json`};
 });
}
