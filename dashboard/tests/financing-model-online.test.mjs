import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {issuanceSnapshot} from './fixtures/issuance.mjs';
import {financingModel} from './visual/report-fixtures.mjs';
import {loadIssuanceModelReport,loadIssuanceModelMetricSource,saveActiveIssuanceSellSide} from '../src/lib/server/issuance-model-repository.ts';
import {saveFinancingModelConclusion,saveTimingDecisionRecord,loadTimingDecisionHistory} from '../src/lib/server/financing-model-repository.ts';
const directory=new URL('../financing-model-migrations/',import.meta.url);
function snapshot(){const value=issuanceSnapshot();value.online_run={model_version:'0123456789abcdef0123',feature_version:'issuance-coupon',training_as_of:'2026-08-01',retrain_after:'2026-08-31',runtime:'cloudflare-workflow',workflow_id:'bond-test',input_prefix:`quant-trial/runs/${value.as_of_date}/bond-test`};return value;}
const publish=(db,value,key=`${value.online_run.input_prefix}/result.json`)=>db.query('SELECT financing_model.publish_online_result($1::jsonb,$2) AS id',[JSON.stringify(value),key]).then(r=>r.rows[0].id);
async function database(){const db=new PGlite();for(const name of (await readdir(directory)).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));await db.query("INSERT INTO financing_model.model_eligibility(model_version,status,reason) VALUES ('0123456789abcdef0123','active','synthetic_test')");return db;}

test('issuance publication round-trips coupon and SHAP while retaining daily manual content',async()=>{
 const db=await database();try{
  const first=snapshot(),id=await publish(db,first),report=await loadIssuanceModelReport(db);
  assert.equal(report.snapshot.run_id,id);assert.equal(report.snapshot.forecast[0].coupon_percent,1.85);
  assert.equal(report.business_metrics,undefined);
  assert.deepEqual(await loadIssuanceModelMetricSource(db,id),{
    issuer:first.terms.issuer,marketDate:first.market_source_date,
  });
  assert.deepEqual(report.snapshot.explanation.features,first.explanation.features);
  assert.deepEqual(report.snapshot.product_scenarios,first.product_scenarios);
  assert.equal(report.snapshot.validation.metrics.length,2);
  assert.equal(report.snapshot.validation.metrics[0].win_rate,.68);
  assert.equal(report.snapshot.validation.metrics[0].hit_rate_5bp,.625);
  assert.equal(report.snapshot.market_forecast.length,11);
  assert.equal((await db.query('SELECT predicted_deviation_bp FROM financing_model.model_run')).rows[0].predicted_deviation_bp,null);
  await saveFinancingModelConclusion(db,{runId:id,verdict:'人工结论',preferredWindow:'下周',narrative:'保留人工判断'});
  await saveTimingDecisionRecord(db,{runId:id,decisionAction:'等待询价',outcome:''});
  await db.query(`INSERT INTO financing_model.sell_side_snapshot(id,run_id,period_start,period_end,search_query,model_name,payload)
    VALUES(gen_random_uuid(),$1,'2026-08-18','2026-08-24','测试','测试',$2::jsonb)`,[id,JSON.stringify(financingModel.sellSide)]);
  const updated=structuredClone(first);updated.run_id=crypto.randomUUID();updated.generated_at='2026-08-24T04:00:00Z';updated.decision.expected_net_saving_bp=3.1;
  assert.equal(await publish(db,updated),id);
  const revised=await loadIssuanceModelReport(db,id);
  assert.equal(revised.snapshot.decision.expected_net_saving_bp,3.1);assert.equal(revised.conclusion.verdict,'人工结论');
  assert.equal(revised.sellSide.logicSummary,financingModel.sellSide.logicSummary);
  const decisions=await loadTimingDecisionHistory(db);assert.equal(decisions[0].runId,id);assert.equal(decisions[0].historicalPercentile,null);
  assert.equal(await publish(db,first),id);assert.equal((await loadIssuanceModelReport(db)).snapshot.decision.expected_net_saving_bp,3.1);
  assert.equal((await db.query('SELECT count(*) FROM financing_model.model_run')).rows[0].count,1);
 }finally{await db.close();}
});

test('issuance publication rejects old models, unavailable labels, broken SHAP and rolls back details',async()=>{
 const db=await database();try{
  const first=snapshot();await publish(db,first);
  await assert.rejects(publish(db,first,'quant-trial/runs/other/result.json'),/Invalid issuance/);
  for(const mutate of [v=>{v.schema_version=3;},v=>{v.online_run.runtime='node';},v=>{v.online_run.retrain_after='2026-08-01';},
    v=>{delete v.online_run.training_as_of;},v=>{v.online_run.model_version='invalid';},v=>{v.forecast[0].market_train_label_end=v.as_of_date;},
    v=>{v.market_forecast[1].date=v.as_of_date;},v=>{v.forecast[0].effective_horizon=30;},
    v=>{v.explanation.prediction_coupon_bp+=1;v.explanation.base_coupon_bp+=1;},v=>{v.explanation=null;},
    v=>{v.explanation.features=[];},v=>{v.explanation.features[0].shap_bp=99;},v=>{v.decision.action='';},
    v=>{v.decision.low_rate_dates=[];},v=>{v.decision.lowest_expected_cost_date=v.as_of_date;},v=>{v.validation.metrics[0].win_rate=2;},v=>{v.product_scenarios[0].bond_type='unknown';},v=>{v.product_scenarios.pop();}]){
   const invalid=structuredClone(first);invalid.generated_at='2026-08-24T05:00:00Z';mutate(invalid);await assert.rejects(publish(db,invalid));
  }
  const broken=structuredClone(first);broken.generated_at='2026-08-24T05:00:00Z';broken.decision.expected_net_saving_bp=99;broken.forecast[1].saving_probability=2;
  await assert.rejects(publish(db,broken),/check constraint/);
  const after=await loadIssuanceModelReport(db);assert.equal(after.snapshot.decision.expected_net_saving_bp,1);assert.equal(after.snapshot.forecast[1].saving_probability,.7);
 }finally{await db.close();}
});

test('unified coupon bundle preserves the report and rejects superseded model packages',async()=>{
 const db=await database();try{
  const value=snapshot();value.online_run.feature_version='issuance-coupon';value.decision.action='等待';
  const id=await publish(db,value);
  const report=await loadIssuanceModelReport(db,id);
  assert.equal(report.snapshot.decision.action,'等待');
  const old=structuredClone(value);old.online_run.feature_version='issuance-lgb-v2';await assert.rejects(publish(db,old),/Invalid issuance/);
  assert.deepEqual(report.snapshot.decision.low_rate_dates,value.decision.low_rate_dates);
  assert.equal(report.conclusion.narrative,'等待');
  assert.equal((await db.query('SELECT model_name,online_feature_version FROM financing_model.model_run WHERE id=$1',[id])).rows[0].model_name,'issuance-coupon');
 }finally{await db.close();}
});


test('absolute hit rate round-trips without relabelling historical sigma success', async () => {
 const db=await database();try {
  const old=snapshot();for(const row of old.validation.metrics)delete row.hit_rate_5bp;
  const id=await publish(db,old);
  const legacy=(await loadIssuanceModelReport(db,id)).snapshot.validation.metrics;
  assert.equal(legacy[0].hit_rate_5bp,null);assert.equal(legacy[0].win_rate,.68);
  const fresh=structuredClone(old);fresh.generated_at='2026-08-24T05:00:00Z';
  for(const row of fresh.validation.metrics){row.hit_rate_5bp=.6;row.win_rate=null;}
  await publish(db,fresh);
  const current=(await loadIssuanceModelReport(db,id)).snapshot.validation.metrics;
  assert.equal(current[0].hit_rate_5bp,.6);assert.equal(current[0].win_rate,null);assert.equal(current[0].error_std_bp,5);
  fresh.generated_at='2026-08-24T06:00:00Z';fresh.validation.metrics[0].hit_rate_5bp=1.1;
  await assert.rejects(publish(db,fresh),/check constraint/);
  assert.equal((await loadIssuanceModelReport(db,id)).snapshot.validation.metrics[0].hit_rate_5bp,.6);
 }finally{await db.close();}
});


test('composite market and coupon attribution round-trips without weakening additive validation',async()=>{
 const db=await database();try{
  const value=snapshot();value.explanation.method='additive_market_coupon';
  const id=await publish(db,value),report=await loadIssuanceModelReport(db,id);
  assert.equal(report.snapshot.explanation.method,'additive_market_coupon');
  assert.deepEqual(report.snapshot.explanation.features,value.explanation.features);
  const broken=structuredClone(value);broken.generated_at='2026-08-24T05:00:00Z';broken.explanation.features[0].shap_bp+=1;
  await assert.rejects(publish(db,broken),/Invalid coupon SHAP/);
  const unknown=structuredClone(value);unknown.explanation.method='unknown';
  await assert.rejects(publish(db,unknown),/Invalid coupon SHAP/);
 }finally{await db.close();}
});


test('ReLU path contributions preserve their method and exact additive publication contract',async()=>{
 const db=await database();try{
  const value=snapshot();value.explanation.method='relu_path_integrated_gradients';
  const id=await publish(db,value),report=await loadIssuanceModelReport(db,id);
  assert.equal(report.snapshot.explanation.method,'relu_path_integrated_gradients');
  assert.deepEqual(report.snapshot.explanation,value.explanation);
  const broken=structuredClone(value);broken.generated_at='2026-08-24T05:00:00Z';broken.explanation.features[0].shap_bp+=1;
  await assert.rejects(publish(db,broken),/Invalid coupon SHAP/);
  assert.deepEqual((await loadIssuanceModelReport(db,id)).snapshot.explanation,value.explanation);
 }finally{await db.close();}
});


function couponPoints(){
 const value=snapshot(),add=h=>new Date(Date.parse(value.as_of_date)+h*86400000).toISOString().slice(0,10);
 value.window_days=30;value.deadline=add(30);value.explanation.method='relu_path_integrated_gradients';
 value.validation={...value.validation,forecast_horizons:[1,14,30],expected_savings_supported:false,
   release_policy:'user_selected_frozen_mlp',qualified:false,candidate:{kind:'mlp'},adoption:{authorized_by:'user'},
   metrics:value.validation.metrics.map(r=>({...r,flat_market_mae_bp:null,mae_skill_vs_flat_market:null}))};
 value.forecast=[1,14,30].map(h=>({...value.forecast[0],date:add(h),lead_days:h,effective_horizon:h,
   coupon_low_percent:null,coupon_high_percent:null,expected_saving_bp:null,waiting_cost_bp:0,net_saving_bp:null,
   annual_saving_wan:null,saving_probability:null,saving_p10_bp:null,pair_samples:null}));
 value.market_forecast=Array.from({length:31},(_,h)=>({...value.market_forecast[0],date:add(h),value_date:add(h)}));
 value.decision={...value.decision,action:'仅预测票面',reason:'coupon_prediction_only',first_issuance_date:null,
   lowest_expected_cost_date:null,low_rate_dates:[],low_rate_windows:[],expected_net_saving_bp:null,
   annual_saving_wan:null,saving_probability:null,saving_p10_bp:null,joint_error_pairs:null};
 return value;
}

test('declared coupon points publish without a timing rule or historical qualification gate',async()=>{
 const db=await database();try{
  const value=couponPoints(),id=await publish(db,value),report=await loadIssuanceModelReport(db,id);
  assert.equal(report.snapshot.decision.action,'仅预测票面');
  assert.equal(report.snapshot.decision.first_issuance_date,null);
  assert.equal(report.snapshot.decision.lowest_expected_cost_date,null);
  assert.deepEqual(report.snapshot.decision.low_rate_dates,[]);
  assert.deepEqual(report.snapshot.forecast.map(r=>r.lead_days),[1,14,30]);
  assert.ok(report.snapshot.forecast.every(r=>r.net_saving_bp===null&&r.coupon_low_percent===null));
  assert.equal(report.snapshot.explanation.method,'relu_path_integrated_gradients');
  assert.equal(report.snapshot.product_scenarios.length,4);
  assert.ok(report.snapshot.forecast.every(r=>r.waiting_cost_bp===0));
  assert.ok(report.snapshot.validation.metrics.every(r=>r.flat_market_mae_bp===null));
  for(const mutate of [v=>{v.forecast[1].lead_days=13;},v=>{v.forecast.pop();},
    v=>{v.decision.action='等待';},v=>{v.decision.lowest_expected_cost_date=v.forecast[0].date;},
    v=>{v.forecast[0].net_saving_bp=1;},v=>{v.forecast[0].coupon_low_percent=1;},
    v=>{v.forecast[0].waiting_cost_bp=1;},v=>{v.forecast[0].waiting_cost_bp=-1;},
    v=>{delete v.validation.forecast_horizons;},v=>{v.validation.expected_savings_supported=true;}]){
   const broken=structuredClone(value);broken.generated_at='2026-08-24T05:00:00Z';mutate(broken);
   await assert.rejects(publish(db,broken));
  }
  assert.equal((await loadIssuanceModelReport(db,id)).snapshot.decision.action,'仅预测票面');
 }finally{await db.close();}
});


test('model identity suspension rejects every publication and preserves historical and manual records',async()=>{
 const db=new PGlite();try{
  const names=(await readdir(directory)).sort();
  for(const name of names.filter(name=>name<'0016'))await db.exec(await readFile(new URL(name,directory),'utf8'));
  const value=snapshot();value.online_run.model_version='61492e3527e1ae367475';
  value.explanation.features.forEach((row,index)=>{row.value=index+1;});
  const id=await publish(db,value);
  await saveFinancingModelConclusion(db,{runId:id,verdict:'人工判断',preferredWindow:'下周',narrative:'保留人工正文'});
  await saveTimingDecisionRecord(db,{runId:id,decisionAction:'跟踪数据',outcome:'保留记录'});
  await db.query(`INSERT INTO financing_model.sell_side_snapshot(id,run_id,period_start,period_end,search_query,model_name,payload)
    VALUES(gen_random_uuid(),$1,'2026-08-18','2026-08-24','测试','测试',$2::jsonb)`,[id,JSON.stringify(financingModel.sellSide)]);
  const before=(await db.query('SELECT to_jsonb(r) AS row FROM financing_model.model_run r')).rows;
  await db.exec(await readFile(new URL('0016_model_data_quality_eligibility.sql',directory),'utf8'));
  assert.deepEqual((await db.query('SELECT to_jsonb(r) AS row FROM financing_model.model_run r')).rows,before);
  const live=await loadIssuanceModelReport(db);
  assert.deepEqual(live.model_status,{model_version:value.online_run.model_version,status:'suspended',reason:'data_quality'});
  for(const field of ['forecast','product_scenarios','market_forecast'])assert.deepEqual(live.snapshot[field],[]);
  assert.equal(live.snapshot.explanation,null);assert.deepEqual(live.snapshot.validation.metrics,[]);
  assert.equal(live.snapshot.decision.expected_net_saving_bp,null);
  assert.equal(live.conclusion.narrative,'保留人工正文');assert.equal(live.sellSide.logicSummary,financingModel.sellSide.logicSummary);
  assert.equal((await loadTimingDecisionHistory(db))[0].decisionAction,'跟踪数据');
  const audit=await loadIssuanceModelReport(db,id);
  assert.equal(audit.model_status.status,'suspended');assert.deepEqual(audit.snapshot.forecast.map(row=>row.coupon_percent),value.forecast.map(row=>row.coupon_percent));
  assert.deepEqual(audit.snapshot.explanation,value.explanation);
  // Fully observed synthetic inputs still fail: this is not a null-only gate.
  assert.ok(value.explanation.features.every(row=>row.value!==null));
  await assert.rejects(publish(db,value),/Model is not active/);
  const maintenance=structuredClone(value);maintenance.online_run.workflow_id='maintenance';maintenance.online_run.input_prefix=`quant-trial/runs/${value.as_of_date}/maintenance`;
  await assert.rejects(publish(db,maintenance),/Model is not active/);
  const unknown=structuredClone(value);unknown.online_run.model_version='abcdef0123456789abcd';
  await assert.rejects(publish(db,unknown),/Model is not active/);
  await db.query(`UPDATE financing_model.model_run SET conclusion_updated_at=NULL WHERE id=$1`,[id]);
  const unedited=await loadIssuanceModelReport(db);assert.equal(unedited.conclusion.narrative,'数据不满足要求，暂停预测');
  await db.query('DELETE FROM financing_model.model_eligibility');
  assert.equal((await loadIssuanceModelReport(db)).model_status.reason,'quality_review_required');
  await saveFinancingModelConclusion(db,{runId:id,verdict:'人工更新',preferredWindow:'',narrative:'暂停期间仍能保存'});
  assert.equal((await loadIssuanceModelReport(db)).conclusion.narrative,'暂停期间仍能保存');
  assert.deepEqual((await db.query('SELECT to_jsonb(f) AS row FROM financing_model.issuance_forecast f ORDER BY ordinal')).rows.map(row=>row.row.coupon_percent),value.forecast.map(row=>row.coupon_percent));
 }finally{await db.close();}
});


test('AI research checks eligibility again at atomic save while manual revisions remain available',async()=>{
 const db=await database();try{
  const id=await publish(db,snapshot()),started=await loadIssuanceModelReport(db,id);
  await saveActiveIssuanceSellSide(db,started,financingModel.sellSide);
  await db.query("UPDATE financing_model.model_eligibility SET status='suspended',reason='data_quality'");
  await assert.rejects(saveActiveIssuanceSellSide(db,started,financingModel.sellSide),error=>error.status===409);
  assert.equal((await db.query('SELECT count(*) FROM financing_model.sell_side_snapshot')).rows[0].count,1);
  const {saveSellSideSummaryRevision}=await import('../src/lib/server/financing-model-repository.ts');
  await saveSellSideSummaryRevision(db,started.snapshot,financingModel.sellSide,{runId:id,logicSummary:'暂停期间人工修订'});
  assert.equal((await loadIssuanceModelReport(db)).sellSide.logicSummary,'暂停期间人工修订');
  await db.query("UPDATE financing_model.model_eligibility SET status='active'");
  await db.query("UPDATE financing_model.model_run SET online_model_version='abcdef0123456789abcd'");
  await assert.rejects(saveActiveIssuanceSellSide(db,started,financingModel.sellSide),error=>error.status===409);
 }finally{await db.close();}
});
