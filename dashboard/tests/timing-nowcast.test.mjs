import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {timingAdviceSnapshot,timingNowcastSnapshot,timingNowcastDetailSnapshot} from './fixtures/timing-advice.mjs';
import {timingNowcastSnapshotSchema} from '../src/lib/timing-advice.ts';
import {loadCurrentFinancingReport} from '../src/lib/server/timing-advice-repository.ts';
import {saveFinancingModelConclusion} from '../src/lib/server/financing-model-repository.ts';
const directory=new URL('../financing-model-migrations/',import.meta.url);
async function database(){const db=new PGlite();for(const name of(await readdir(directory)).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 await db.query("INSERT INTO financing_model.model_eligibility(model_version,status,reason) VALUES ('fedcba9876543210fedc','active','post_hoc_selected'),('abcdef0123456789abcd','active','user_selected_exploratory')");return db;}
const publish=(db,v,key=`${v.online_run.input_prefix}/result.json`)=>db.query('SELECT financing_model.publish_online_result($1::jsonb,$2) AS id',[JSON.stringify(v),key]).then(r=>r.rows[0].id);
test('nowcast publishes forecast and threshold action, keeps manual content, ignores stale replay',async()=>{
 const db=await database();try{
 const first=timingNowcastSnapshot(),id=await publish(db,first),report=await loadCurrentFinancingReport(db);
 assert.equal(report.snapshot.schema_version,'timing-advice-v2');assert.deepEqual(report.snapshot.forecast,first.forecast);assert.deepEqual(report.snapshot.probabilities,first.probabilities);assert.equal(report.snapshot.decision.action,'暂缓');
 await saveFinancingModelConclusion(db,{runId:id,verdict:'人工判断',preferredWindow:'',narrative:'保留人工结论'});
 const newer=structuredClone(first);newer.run_id=crypto.randomUUID();newer.generated_at='2026-10-28T02:00:00Z';newer.forecast.wait_bp=.2;newer.decision.action='等待';newer.base_conclusion.verdict='等待';
 assert.equal(await publish(db,newer),id);const updated=await loadCurrentFinancingReport(db);assert.equal(updated.snapshot.decision.action,'等待');assert.equal(updated.conclusion.narrative,'保留人工结论');
 assert.equal(await publish(db,first),id);assert.equal((await loadCurrentFinancingReport(db)).snapshot.forecast.wait_bp,.2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.timing_nowcast_run')).rows[0].n,1);
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended'");await assert.rejects(loadCurrentFinancingReport(db),e=>e.status===409);
 }finally{await db.close();}
});
test('stale v1 replay keeps the v2 run, the threshold edge is 等待 and manual content survives a model switch',async()=>{
 const db=await database();try{
 const v2=timingNowcastSnapshot(),id=await publish(db,v2);
 await saveFinancingModelConclusion(db,{runId:id,verdict:'人工判断',preferredWindow:'',narrative:'保留人工结论'});
 const stale=timingAdviceSnapshot();stale.generated_at='2026-10-28T00:30:00Z';assert.equal(await publish(db,stale),id);
 const kept=await loadCurrentFinancingReport(db);assert.equal(kept.snapshot.schema_version,'timing-advice-v2');assert.equal(kept.conclusion.narrative,'保留人工结论');
 const edge=structuredClone(v2);edge.generated_at='2026-10-28T02:00:00Z';edge.forecast.wait_bp=.5;edge.decision.action='等待';edge.base_conclusion.verdict='等待';
 assert.equal(await publish(db,edge),id);assert.equal((await loadCurrentFinancingReport(db)).snapshot.decision.action,'等待');
 const below=structuredClone(edge);below.generated_at='2026-10-28T03:00:00Z';below.forecast.wait_bp=-.5;assert.equal(await publish(db,below),id);
 assert.throws(()=>timingNowcastSnapshotSchema.parse({...edge,forecast:{...edge.forecast,wait_bp:.5001}}));
 const back=timingAdviceSnapshot();back.generated_at='2026-10-28T04:00:00Z';assert.equal(await publish(db,back),id);assert.equal((await loadCurrentFinancingReport(db)).conclusion.narrative,'保留人工结论');
 }finally{await db.close();}
});
test('a v2 run replaces a v1 run of the same day and a v1 republish returns to v1',async()=>{
 const db=await database();try{
 const v1=timingAdviceSnapshot(),id=await publish(db,v1),v2=timingNowcastSnapshot();v2.generated_at='2026-10-28T02:00:00Z';
 assert.equal(await publish(db,v2),id);assert.equal((await loadCurrentFinancingReport(db)).snapshot.schema_version,'timing-advice-v2');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.timing_run')).rows[0].n,0);
 const back=structuredClone(v1);back.generated_at='2026-10-28T03:00:00Z';assert.equal(await publish(db,back),id);
 assert.equal((await loadCurrentFinancingReport(db)).snapshot.schema_version,'timing-advice-v1');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.timing_nowcast_run')).rows[0].n,0);
 }finally{await db.close();}
});
test('nowcast refuses an action that disagrees with the threshold, bad probabilities, dates and identity',async()=>{
 const db=await database();try{
 const first=timingNowcastSnapshot();
 for(const change of [v=>{v.decision.action='尽快';v.base_conclusion.verdict='尽快';},v=>{v.forecast.wait_bp=.3;},v=>{v.probabilities.issue=.9;},v=>{v.probabilities.defer=-.1;},v=>{v.market_source_date=v.as_of_date;},v=>{v.online_run.runtime='local';},v=>{v.online_run.feature_version='timing-advice-v1';},v=>{v.online_run.model_version='0123456789abcdef0123';},v=>{v.training_label_cutoff='2026-10-28';},v=>{v.validation.prediction_end='2026-10-28';},v=>{v.forecast.wait_quotes=2;},v=>{v.validation.spread_ci_low_bp=2;},v=>{v.explanation={};},v=>{delete v.forecast.catch_up_bp;},v=>{v.forecast.wait_bp='NaN';},v=>{v.forecast.threshold_bp='0.5';},v=>{v.validation.sample_count='1433';},v=>{v.window_days=30;}]){const invalid=structuredClone(first);change(invalid);await assert.rejects(publish(db,invalid));}
 await assert.rejects(publish(db,first,'wrong/result.json'));
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended'");await assert.rejects(publish(db,first),/not active/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.model_run')).rows[0].n,0);
 const wrong=structuredClone(first);wrong.forecast.wait_bp=-.1;assert.throws(()=>timingNowcastSnapshotSchema.parse(wrong));
 assert.equal(timingNowcastSnapshotSchema.parse(first).decision.action,'暂缓');
 }finally{await db.close();}
});
test('detail rows round-trip, a rerun replaces them, a v1 return removes them and legacy rows still load',async()=>{
 const db=await database();try{
 const legacy=timingNowcastSnapshot(),id=await publish(db,legacy);
 const old=await loadCurrentFinancingReport(db);assert.equal(old.snapshot.history,undefined);assert.equal(old.snapshot.attribution,undefined);
 const detail=timingNowcastDetailSnapshot();detail.generated_at='2026-10-28T02:00:00Z';assert.equal(await publish(db,detail),id);
 const report=await loadCurrentFinancingReport(db);
 assert.deepEqual(report.snapshot.forecast,detail.forecast);assert.deepEqual(report.snapshot.history,detail.history);assert.deepEqual(report.snapshot.attribution,detail.attribution);
 const again=structuredClone(detail);again.generated_at='2026-10-28T03:00:00Z';again.history=again.history.slice(1);assert.equal(await publish(db,again),id);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.timing_nowcast_history')).rows[0].n,19);
 const edge=structuredClone(detail);edge.generated_at='2026-10-28T04:00:00Z';edge.forecast.wait_quote_date=null;assert.equal(await publish(db,edge),id);
 assert.equal((await loadCurrentFinancingReport(db)).snapshot.forecast.wait_quote_date,null);
 const back=timingAdviceSnapshot();back.generated_at='2026-10-28T05:00:00Z';assert.equal(await publish(db,back),id);
 for(const table of ['timing_nowcast_history','timing_nowcast_attribution'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM financing_model.${table}`)).rows[0].n,0);
 }finally{await db.close();}
});
test('detail that does not reconcile, repeats a group or ends before the source quote is refused',async()=>{
 const db=await database();try{
 const first=timingNowcastDetailSnapshot();
 for(const change of [v=>{v.attribution[0].wait_bp+=.01;},v=>{v.attribution[1].catch_up_bp+=.01;},v=>{v.attribution[1].group='sector';},v=>{v.attribution.pop();},v=>{v.history.pop();},v=>{v.history[0].yield_pct=0;},v=>{v.history.push({date:'2026-10-28',yield_pct:2});v.forecast.source_yield_pct=2;},v=>{v.forecast.source_yield_pct=1.5;},v=>{v.forecast.decision_quote_date='2026-10-27';},v=>{v.forecast.wait_quote_date='2026-10-28';},v=>{delete v.history;},v=>{delete v.forecast.wait_base_bp;},v=>{v.attribution[0].wait_bp='NaN';}]){
  const invalid=structuredClone(first);change(invalid);await assert.rejects(publish(db,invalid));assert.throws(()=>timingNowcastSnapshotSchema.parse(invalid));}
 assert.equal((await db.query('SELECT count(*)::int AS n FROM financing_model.model_run')).rows[0].n,0);
 assert.equal(timingNowcastSnapshotSchema.parse(first).attribution.length,5);
 }finally{await db.close();}
});
