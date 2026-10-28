import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import pg from "pg";
import sources from "./sources.json";
import queries from "./queries.json";
import { publishArchivedResult } from "./publication.mjs";
import { infer, validDate, validateModel } from "./issuance.mjs";
import { validateIndustryProfile } from "./issuance-features.mjs";
import { CURVE_GRID_SQL, decodeCurveGrid } from "./curve-grid.mjs";
import { segmentedCoupon, couponInputBatch } from "./segmented-coupon.mjs";
import { requireActiveModel } from "./model-eligibility.mjs";
import { validateTimingModel } from "./timing-advice.mjs";
import { runTimingWorkflow } from "./timing-workflow.mjs";
type Parameters = { as_of_date?: string; input_batch?: any; input_snapshot_prefix?: string; publish_result_key?: string; window_days?: number; issue_size_yi?: number; terms?: { issuer?: string; rating?: string; bond_type?: string; placement_type?: string; tenor?: number } };
const prefix = "quant-trial";
const shanghaiDate = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
async function sha256(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
async function readJson<T = Record<string, any>>(
  bucket: R2Bucket,
  key: string,
  maxBytes = 16 * 1024 * 1024,
  expectedHash?: string,
): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new NonRetryableError(`Artifact missing: ${key}`);
  if (object.size > maxBytes)
    throw new NonRetryableError("Artifact exceeds size limit");
  const bytes = await object.arrayBuffer();
  const expected = expectedHash ?? object.customMetadata?.sha256;
  if (expected && (await sha256(bytes)) !== expected)
    throw new NonRetryableError("Artifact checksum mismatch");
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function putJson(bucket: R2Bucket, key: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    customMetadata: { sha256: await sha256(bytes) },
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}
async function modelFile(bucket: R2Bucket, manifest, name: string) {
  const entry = manifest.models[name];
  if (!entry || !/^model-(main|\d+)\.json$/.test(entry.file))
    throw new NonRetryableError("Invalid model entry");
  const object = await bucket.get(
    `${prefix}/models/${manifest.model_version}/${entry.file}`,
  );
  if (!object || object.size > 16 * 1024 * 1024)
    throw new NonRetryableError("Model missing or oversized");
  const bytes = await object.arrayBuffer();
  const digest = await sha256(bytes);
  if (digest !== entry.sha256)
    throw new NonRetryableError("Model checksum mismatch");
  const model = JSON.parse(new TextDecoder().decode(bytes));
  if(manifest.feature_version==='timing-advice-v1') validateTimingModel(manifest,model);
  else validateModel(manifest, model);
  return model;
}

export class BondInferenceWorkflow extends WorkflowEntrypoint<Env, Parameters> {
  async run(event: WorkflowEvent<Parameters>, step: WorkflowStep) {
    if (event.payload.publish_result_key !== undefined) return step.do("publish-result", () => publishArchivedResult(this.env,event.payload.publish_result_key,pg.Client));
    const date=event.payload.as_of_date ?? shanghaiDate();
    if (!validDate(date)||date>shanghaiDate()) throw new NonRetryableError("Invalid model date");
    if(event.payload.input_batch){
      try{return await couponInputBatch(this.env,step,event,{putJson,readJson,sha256});}
      catch(error){
        const task=event.payload.input_batch;
        await step.do('notify-input-failure',{retries:{limit:0,delay:'1 second'}},async()=>{
          const parent=await this.env.INFERENCE.get(task.parent_id);
          await parent.sendEvent({type:`coupon-batch-${task.index}`,payload:{parent_id:task.parent_id,child_id:event.instanceId,index:task.index,error:'input_batch_failed'}});
        });
        throw error;
      }
    }
    const runPrefix=`${prefix}/runs/${date}/${event.instanceId}`;
    const manifest=await step.do("pin-model",async()=>{
      if (await this.env.ARTIFACTS.head(`${runPrefix}/manifest.json`)) return readJson(this.env.ARTIFACTS,`${runPrefix}/manifest.json`);
      const pointer=await readJson(this.env.ARTIFACTS,this.env.MODEL_POINTER);
      if(!/^[a-f0-9]{20}$/.test(pointer.model_version)) throw new NonRetryableError("Invalid pointer");
      const value=await readJson(this.env.ARTIFACTS,`${prefix}/models/${pointer.model_version}/manifest.json`,128*1024,pointer.manifest_sha256);
      if(!["issuance-coupon","timing-advice-v1"].includes(value.feature_version)||value.model_version!==pointer.model_version||date<value.training_as_of||date>value.retrain_after) throw new NonRetryableError("Invalid or expired issuance bundle");
      await putJson(this.env.ARTIFACTS,`${runPrefix}/manifest.json`,value);
      return readJson(this.env.ARTIFACTS,`${runPrefix}/manifest.json`);
    });
    await step.do('check-model-eligibility',async()=>{
      const client=new pg.Client({connectionString:this.env.HYPERDRIVE.connectionString,connectionTimeoutMillis:15000,query_timeout:30000});
      try {
        await client.connect();
        await requireActiveModel(client,manifest.model_version);
      } catch(error) {
        throw new NonRetryableError(error instanceof Error?error.message:'Model eligibility unavailable');
      } finally {await client.end();}
    });
    if(manifest.feature_version==='timing-advice-v1') return runTimingWorkflow(this.env,step,event,manifest,{putJson,readJson,modelFile});
    const usesIndustry=(manifest.required_input_groups??[]).some((name:string)=>["industry_curve","industry_nodes"].includes(name));
    if(usesIndustry)validateIndustryProfile(manifest.industry_source_profile);
    await step.do("freeze-inputs",async()=>{
      const key=`${runPrefix}/inputs.json`;
      if(await this.env.ARTIFACTS.head(key)) return key;
      if(event.payload.input_snapshot_prefix!==undefined){
        const source=event.payload.input_snapshot_prefix;
        if(!new RegExp(`^quant-trial/runs/${date}/[A-Za-z0-9_-]{1,100}$`).test(source))throw new NonRetryableError('Invalid input snapshot reference');
        const frozen=await readJson(this.env.ARTIFACTS,`${source}/manifest.json`);
        if(frozen.model_version!==manifest.model_version)throw new NonRetryableError('Snapshot model identity differs');
        const object=await this.env.ARTIFACTS.get(`${source}/inputs.json`);
        if(!object||object.size>32*1024*1024||!object.customMetadata?.sha256)throw new NonRetryableError('Snapshot unavailable');
        await this.env.ARTIFACTS.put(key,object.body,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:object.customMetadata.sha256},httpMetadata:{contentType:'application/json'}});
        return key;
      }
      const client=new pg.Client({connectionString:this.env.HYPERDRIVE.connectionString,connectionTimeoutMillis:15000,query_timeout:60000});
      try {
        await client.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const datasets: Record<string,unknown>={};
        for(const group of (manifest.required_input_groups??["funding","issue"]) as string[]) {
          if(group==="issuer_daily") {
            const result=await client.query(queries.issuer_daily_live,[date,"2019-01-01"]);
            datasets[group]=JSON.parse(result.rows[0].payload);continue;
          }
          if(group==="industry_nodes") {
            const result=await client.query(CURVE_GRID_SQL,[date]);
            if(result.rows.length!==1)throw new NonRetryableError('Invalid industry curve identity');
            const payload=result.rows[0].payload;
            if(payload.length>16*1024*1024||payload==='[]')throw new NonRetryableError('Invalid industry node inputs');
            const grid=JSON.parse(payload);
            decodeCurveGrid(grid);
            datasets[group]=grid;continue;
          }
          if(group==="bond_issuance") {
            const result=await client.query("SELECT coalesce(json_agg(t),'[]'::json)::text AS payload FROM (SELECT *,issue_date::text AS observation_date FROM public.bond_issuance WHERE issue_date<$1::date ORDER BY bond_code) t",[date]);
            const payload=result.rows[0].payload;
            if(payload.length>16*1024*1024||payload==='[]')throw new NonRetryableError('Invalid bond issuance inputs');
            datasets[group]=JSON.parse(payload);continue;
          }
          if(group==="issue") {
            const result=await client.query(`SELECT coalesce(json_agg(t),'[]'::json)::text AS payload FROM (${queries.issue}) t`,[date]);
            const payload=result.rows[0].payload;
            if(payload.length>16*1024*1024||payload==='[]')throw new NonRetryableError('Invalid issue inputs');
            datasets[group]=JSON.parse(payload);continue;
          }
          if(group!=="industry_curve"&&!(group in sources)) throw new NonRetryableError(`Unknown input group: ${group}`);
          const edb=group==="funding"||group==="macro";
          const sql=group==="industry_curve"?queries.industry_curve:edb?queries.edb:queries.quant;
          const args=group==="industry_curve"?["5781a1ff7651967e0176978d957b7346",date]:[Object.keys(sources[group as keyof typeof sources]),date];
          const result=await client.query(`SELECT COALESCE(json_agg(t),'[]'::json)::text AS payload FROM (${sql}) t WHERE t.observation_date::date >= '2019-01-01'::date`,args);
          const payload=result.rows[0].payload;
          if(payload.length>16*1024*1024||payload==='[]') throw new NonRetryableError(`Invalid input: ${group}`);
          datasets[group]=JSON.parse(payload);
        }
        await client.query("COMMIT");
        return putJson(this.env.ARTIFACTS,key,{schema_version:1,as_of_date:date,issuance_scope:manifest.issuance_scope??"all",...(usesIndustry?{industry_source_profile:manifest.industry_source_profile}:{}),datasets});
      } finally {await client.end();}
    });
    const model=await step.do('load-coupon-model',()=>modelFile(this.env.ARTIFACTS,manifest,'main'));
    const key=model.candidate.kind==='mlp'
      ?await segmentedCoupon(this.env,step,manifest,model,event,runPrefix,{putJson,readJson,sha256})
      :await step.do("predict-coupon-with-shap",async()=>{
      const inputs=await readJson(this.env.ARTIFACTS,`${runPrefix}/inputs.json`,32*1024*1024);
      let result;
      try {
        result=await infer(manifest,inputs,()=>model,event.payload);
      } catch (error) {
        if(error instanceof Error&&error.message==="Stale market quote") throw new NonRetryableError(error.message);
        throw error;
      }
      Object.assign(result.online_run,{runtime:"cloudflare-workflow",input_prefix:runPrefix,workflow_id:event.instanceId});
      return putJson(this.env.ARTIFACTS,`${runPrefix}/result.json`,result);
    });
    return step.do("publish-result",()=>publishArchivedResult(this.env,key,pg.Client));
  }
}
export default {
  fetch() {return new Response("Not found",{status:404});},
  async scheduled(_event:ScheduledController,env:Env) {
    const date=shanghaiDate();
    await env.INFERENCE.create({id:`bond-${date}`,params:{as_of_date:date}});
  }
} satisfies ExportedHandler<Env>;
