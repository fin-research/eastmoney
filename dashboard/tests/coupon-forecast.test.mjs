import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {couponForecastSnapshot,timingNowcastSnapshot} from './fixtures/timing-advice.mjs';
const directory=new URL('../financing-model-migrations/',import.meta.url);
async function database(){const db=new PGlite();for(const name of(await readdir(directory)).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 await db.query("INSERT INTO financing_model.model_eligibility(model_version,status,reason) VALUES ('0f1e2d3c4b5a69788796','active','post_hoc_selected'),('fedcba9876543210fedc','active','post_hoc_selected')");return db;}
const publish=(db,v,key=`${v.online_run.input_prefix}/result.json`)=>db.query('SELECT financing_model.publish_online_result($1::jsonb,$2) AS id',[JSON.stringify(v),key]).then(r=>r.rows[0].id);
const count=async(db,table)=>(await db.query(`SELECT count(*)::int AS n FROM financing_model.${table}`)).rows[0].n;
test('coupon forecast publishes four products with groups, contributions and path',async()=>{
 const db=await database();try{
 const value=couponForecastSnapshot(),id=await publish(db,value);
 assert.equal(id,value.run_id);
 assert.equal(await count(db,'coupon_forecast_product'),4);assert.equal(await count(db,'coupon_forecast_group'),28);
 assert.equal(await count(db,'coupon_forecast_contribution'),24);assert.equal(await count(db,'coupon_forecast_path'),20);
 const row=(await db.query("SELECT coupon_pct,base_coupon_bp FROM financing_model.coupon_forecast_product WHERE product_key='3y-public'")).rows[0];
 assert.ok(Math.abs(row.coupon_pct-value.products[0].coupon_pct)<1e-12);
 assert.equal(await count(db,'model_run'),0);
 }finally{await db.close();}
});
test('a newer rerun replaces the same-day rows, a stale replay and a timing publish leave them',async()=>{
 const db=await database();try{
 const first=couponForecastSnapshot(),id=await publish(db,first);
 const newer=structuredClone(first);newer.generated_at='2026-10-28T02:00:00Z';newer.run_id=crypto.randomUUID();newer.products[0].path.pop();
 assert.equal(await publish(db,newer),id);assert.equal(await count(db,'coupon_forecast_path'),19);
 assert.equal(await publish(db,first),id);assert.equal(await count(db,'coupon_forecast_path'),19);
 assert.equal(await count(db,'coupon_forecast_run'),1);
 const timing=timingNowcastSnapshot();await publish(db,timing);
 assert.equal(await count(db,'coupon_forecast_run'),1);assert.equal(await count(db,'model_run'),1);
 }finally{await db.close();}
});
test('coupon forecast refuses contributions that do not reconcile, wrong shape, identity and an inactive model',async()=>{
 const db=await database();try{
 const first=couponForecastSnapshot();
 const changes=[v=>{v.products[0].groups[0].net_bp+=.01;},v=>{v.products[1].coupon_pct+=.0001;},v=>{v.products[0].contributions[0].contribution_bp+=.01;},
  v=>{v.products.pop();},v=>{v.products[1].key='3y-public';},v=>{v.products[0].groups.pop();},v=>{v.products[0].groups[1].group='未知';},
  v=>{v.products[0].path[0].date='2026-10-27';},v=>{v.products[0].path=[];},v=>{v.products[0].n_prior=1;},v=>{v.products[0].anchor_pct=0;},v=>{v.products[0].bond_type='证券公司次级债';},
  v=>{v.market_source_date=v.as_of_date;},v=>{v.timing.action='尽快';},v=>{v.online_run.runtime='local';},v=>{v.online_run.feature_version='timing-advice-v2';},
  v=>{v.model_version='0123456789abcdef0123';},v=>{v.training_label_cutoff='2026-10-28';},v=>{v.validation.holdout.mae_bp='7';},v=>{delete v.validation.development;},
  v=>{v.products[0].contributions[0].group='未知';},v=>{v.products[0].contributions[0].value='NaN';}];
 for(const change of changes){const invalid=structuredClone(first);change(invalid);await assert.rejects(publish(db,invalid));}
 await assert.rejects(publish(db,first,'wrong/result.json'));
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended'");await assert.rejects(publish(db,first),/not active/);
 assert.equal(await count(db,'coupon_forecast_run'),0);
 }finally{await db.close();}
});
import {loadCurrentFinancingReport} from '../src/lib/server/timing-advice-repository.ts';
test('the timing report carries the same-day coupon forecast and stays valid without it',async()=>{
 const db=await database();try{
 await publish(db,timingNowcastSnapshot());
 assert.equal((await loadCurrentFinancingReport(db)).coupon??null,null);
 const value=couponForecastSnapshot();await publish(db,value);
 const report=await loadCurrentFinancingReport(db);
 assert.equal(report.coupon.products.length,4);assert.deepEqual(report.coupon.products[0].path.map(p=>p.date),value.products[0].path.map(p=>p.date));
 assert.deepEqual(report.coupon.products[2].groups.map(g=>g.group),['利率','信用','资金面','基本面','一级发行','二级行情','发行条款']);
 assert.equal(report.coupon.validation.holdout.sample_count,62);
 await db.query("UPDATE financing_model.model_eligibility SET status='suspended' WHERE model_version='0f1e2d3c4b5a69788796'");
 assert.equal((await loadCurrentFinancingReport(db)).coupon??null,null);
 }finally{await db.close();}
});
