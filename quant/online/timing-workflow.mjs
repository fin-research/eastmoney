import pg from 'pg';
import sources from './sources.json' with { type: 'json' };
import { inferTiming, previousTimingQuoteDay } from './timing-advice.mjs';
import { publishArchivedResult } from './publication.mjs';

/** Small, immutable T-1 quote snapshot; no primary-issuance or imputed inputs. */
export async function runTimingWorkflow(env, step, event, manifest, io) {
  const date=event.payload.as_of_date??new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
  const prefix=`quant-trial/runs/${date}/${event.instanceId}`;
  const model=await step.do('load-timing-model',()=>io.modelFile(env.ARTIFACTS,manifest,'main'));
  await step.do('freeze-timing-inputs',async()=>{
    if(await env.ARTIFACTS.head(`${prefix}/inputs.json`))return;
    const client=new pg.Client({connectionString:env.HYPERDRIVE.connectionString,connectionTimeoutMillis:15000,query_timeout:30000});
    try {
      await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const funding=await client.query(`SELECT indicator_code AS field,observation_date::text,published_date::text,value::float8 AS value FROM public.edb
        WHERE indicator_code=ANY($1::text[]) AND observation_date >= $2::date-interval '90 days' AND observation_date<$2::date
        AND COALESCE(published_date,observation_date)<$2::date ORDER BY observation_date,indicator_code`,[Object.keys(sources.funding),date]);
      const sector=await client.query(`SELECT observation_date::text,yield_pct::float8 FROM public.bond_industry_curve
        WHERE curve_code=$1 AND tenor_years=3 AND observation_date >= $2::date-interval '90 days' AND observation_date<$2::date ORDER BY observation_date`,['5781a1ff7651967e0176978d957b7346',date]);
      await client.query('COMMIT');
      await io.putJson(env.ARTIFACTS,`${prefix}/inputs.json`,{schema_version:1,as_of_date:date,
        required_source_date:previousTimingQuoteDay(date,manifest.calendar),datasets:{funding:funding.rows,sector3:sector.rows}});
    } finally {await client.end();}
  });
  const key=await step.do('predict-timing-advice',{retries:{limit:0,delay:'1 second'}},async()=>{
    const inputs=await io.readJson(env.ARTIFACTS,`${prefix}/inputs.json`,256*1024);
    const result=inferTiming(manifest,model,inputs);
    Object.assign(result.online_run,{runtime:'cloudflare-workflow',input_prefix:prefix,workflow_id:event.instanceId});
    return io.putJson(env.ARTIFACTS,`${prefix}/result.json`,result);
  });
  return step.do('publish-result',()=>publishArchivedResult(env,key,pg.Client));
}
