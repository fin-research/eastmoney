import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {timingAdviceSnapshot} from './fixtures/timing-advice.mjs';
import {timingAdviceSnapshotSchema} from '../src/lib/timing-advice.ts';
import {loadCurrentFinancingReport} from '../src/lib/server/timing-advice-repository.ts';
import {saveFinancingModelConclusion,saveTimingDecisionRecord,loadTimingDecisionHistory} from '../src/lib/server/financing-model-repository.ts';
import {loadIssuanceModelMetricSource} from '../src/lib/server/issuance-model-repository.ts';
const directory=new URL('../financing-model-migrations/',import.meta.url);
async function database(){const db=new PGlite();for(const name of(await readdir(directory)).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));await db.query("INSERT INTO financing_model.model_eligibility(model_version,status,reason) VALUES ('abcdef0123456789abcd','active','user_selected_exploratory')");return db;}
const publish=(db,v,key=`${v.online_run.input_prefix}/result.json`)=>db.query('SELECT financing_model.publish_online_result($1::jsonb,$2) AS id',[JSON.stringify(v),key]).then(r=>r.rows[0].id);
test('timing advice publishes typed probabilities, preserves manual content and daily id, ignores stale replay',async()=>{
 const db=await database();try{
 const first=timingAdviceSnapshot(),id=await publish(db,first),report=await loadCurrentFinancingReport(db);
 assert.deepEqual(report.snapshot.probabilities,first.probabilities);assert.equal(report.snapshot.schema_version,'timing-advice-v1');assert.equal(report.snapshot.training_label_cutoff,'2025-12-31');
 assert.deepEqual(await loadIssuanceModelMetricSource(db,id),{issuer:'东方财富证券股份有限公司',marketDate:'2026-10-27'});
 assert.equal((await db.query('SELECT issue_size_billion_yuan FROM financing_model.model_run')).rows[0].issue_size_billion_yuan,null);
 await saveFinancingModelConclusion(db,{runId:id,verdict:'人工判断',preferredWindow:'',narrative:'保留人工结论'});await saveTimingDecisionRecord(db,{runId:id,decisionAction:'已发行',outcome:''});
 const newer=structuredClone(first);newer.run_id=crypto.randomUUID();newer.generated_at='2026-10-28T02:00:00Z';newer.probabilities={defer:.1,wait:.2,issue:.7};
 assert.equal(await publish(db,newer),id);assert.equal((await loadCurrentFinancingReport(db)).conclusion.narrative,'保留人工结论');
 assert.equal((await loadTimingDecisionHistory(db))[0].decisionAction,'已发行');assert.equal(await publish(db,first),id);assert.equal((await loadCurrentFinancingReport(db)).snapshot.probabilities.issue,.7);
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended'");await assert.rejects(loadCurrentFinancingReport(db),e=>e.status===409);assert.equal((await loadCurrentFinancingReport(db,id)).conclusion.narrative,'保留人工结论');
 await db.query("DELETE FROM financing_model.model_eligibility");await assert.rejects(loadCurrentFinancingReport(db),e=>e.status===409);
 await db.query("INSERT INTO financing_model.model_eligibility VALUES ('abcdef0123456789abcd','active','synthetic',now())");
 const broken=structuredClone(newer);broken.generated_at='2026-10-28T03:00:00Z';broken.validation.immediate_recall=.99;await assert.rejects(publish(db,broken));assert.equal((await loadCurrentFinancingReport(db)).snapshot.generated_at,'2026-10-28T02:00:00+00:00');
 }finally{await db.close();}
});
test('timing advice refuses fake coupon fields, invalid probabilities, dates, source and suspended identity',async()=>{
 const db=await database();try{
 const first=timingAdviceSnapshot();
 for(const change of [v=>{v.probabilities.issue=.9;},v=>{v.probabilities.defer=-.1;},v=>{v.decision.action='等待';},v=>{v.market_source_date=v.as_of_date;},v=>{v.online_run.runtime='local';},v=>{v.online_run.model_version='0123456789abcdef0123';},v=>{v.online_run.retrain_after='2026-10-27';},v=>{v.training_label_cutoff='2026-10-28';},v=>{v.forecast=[];},v=>{delete v.validation.logloss;},v=>{v.probabilities.issue='NaN';}]){const invalid=structuredClone(first);change(invalid);await assert.rejects(publish(db,invalid));}
 await assert.rejects(publish(db,first,'wrong/result.json'));
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended'");await assert.rejects(publish(db,first),/not active/);
 assert.equal((await db.query('SELECT count(*) FROM financing_model.model_run')).rows[0].count,0);
 assert.throws(()=>timingAdviceSnapshotSchema.parse({...first,decision:{action:'等待'}}));
 }finally{await db.close();}
});

test('current report fixes the selected run before concurrent newer publication',async()=>{
 const db=await database();try{
 const first=timingAdviceSnapshot();first.as_of_date='2026-10-26';first.market_source_date='2026-10-25';first.online_run.training_as_of='2026-10-01';first.online_run.input_prefix='quant-trial/runs/2026-10-26/timing-test';
 const id=await publish(db,first);
 const newer=structuredClone(first);newer.run_id=crypto.randomUUID();newer.as_of_date='2026-10-27';newer.market_source_date='2026-10-26';newer.online_run.input_prefix='quant-trial/runs/2026-10-27/timing-test';
 let inserted=false;
 const client={async query(sql,params){const result=await db.query(sql,params);if(!inserted&&sql.startsWith('SELECT id,schema_version')){inserted=true;await publish(db,newer);}return result;}};
 const report=await loadCurrentFinancingReport(client);assert.equal(report.snapshot.run_id,id);assert.equal(report.snapshot.as_of_date,'2026-10-26');assert.equal((await loadCurrentFinancingReport(db)).snapshot.as_of_date,'2026-10-27');
 }finally{await db.close();}
});
