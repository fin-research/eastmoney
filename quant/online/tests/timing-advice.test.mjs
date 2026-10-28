import test from 'node:test';
import assert from 'node:assert/strict';
import sources from '../sources.json' with { type: 'json' };
import { inferTiming, previousTimingQuoteDay, timingFeatures } from '../timing-advice.mjs';

function fixture() {
  const names=['GOV_1Y','GOV_3Y','GOV_10Y','CDB_3Y','CDB_10Y','AAA_3Y'];
  const features=names.flatMap(name=>Array.from({length:20},(_,i)=>`path_${name.toLowerCase()}_lag_${i+1}_bp`));
  features.push(...Array.from({length:20},(_,i)=>`path_own_lag_${i+1}_bp`));
  const calendar={year:2026,closures:[],makeup_workdays:[]};
  const manifest={feature_version:'timing-advice-v1',calendar,model_version:'test',validation:{validation_scope:'inner_development'}};
  const model={kind:'linear_timing',features,mean:Array(140).fill(0),std:Array(140).fill(1),constant:Array(140).fill(false),theta:Array(290).fill(0),centers:[-1,0,1]};
  const funding=[],sector3=[];
  for(let day=1;day<=31;day++) {
    const date=`2026-08-${String(day).padStart(2,'0')}`;
    for(const [field,name] of Object.entries(sources.funding)) if(names.includes(name))funding.push({field,observation_date:date,published_date:date,value:2+day/100});
    sector3.push({observation_date:date,yield_pct:3+day/100});
  }
  return {manifest,model,inputs:{as_of_date:'2026-09-01',required_source_date:'2026-08-31',datasets:{funding,sector3}}};
}

test('learned coefficients control all three actions without a market-direction override',()=>{
  const {manifest,model,inputs}=fixture();
  assert.equal(inferTiming(manifest,model,inputs).decision.action,'暂缓'); // original first argmax tie
  model.theta[280]=1;
  assert.equal(inferTiming(manifest,model,inputs).decision.action,'暂缓');
  model.theta[280]=-1;model.theta[281]=-1;
  assert.equal(inferTiming(manifest,model,inputs).decision.action,'等待');
  model.theta[281]=1;
  assert.equal(inferTiming(manifest,model,inputs).decision.action,'尽快');
});
test('raw lag path is relative to source quote; a delayed observation uses availability day',()=>{
  const {model,inputs}=fixture();
  assert.ok(Math.abs(timingFeatures(inputs,model.features)[0]+1)<1e-10);
  const row=inputs.datasets.funding.find(r=>r.observation_date==='2026-08-31');
  row.observation_date='2026-08-30'; // released on 31, no fabricated previous close
  assert.ok(Math.abs(timingFeatures(inputs,model.features)[0]+1)<1e-10);
});
test('rejects absent source quotes and insufficient history without filling',()=>{
  const {manifest,model,inputs}=fixture();
  inputs.datasets.sector3.pop();
  assert.throws(()=>inferTiming(manifest,model,inputs),/Stale/);
  const fresh=fixture();fresh.inputs.datasets.sector3=fresh.inputs.datasets.sector3.slice(-20);
  assert.throws(()=>inferTiming(fresh.manifest,fresh.model,fresh.inputs),/Incomplete/);
});
test('rejects future observations, availability collisions, invalid coefficients and wrong T-1',()=>{
  for(const mutate of [
    f=>{f.inputs.datasets.funding[0].published_date='2026-09-01';},
    f=>{f.inputs.datasets.funding.push({...f.inputs.datasets.funding[0]});},
    f=>{f.model.theta[0]=NaN;},
    f=>{f.inputs.required_source_date='2026-08-30';},
  ]) {const f=fixture();mutate(f);assert.throws(()=>inferTiming(f.manifest,f.model,f.inputs));}
});
test('verified quote calendar supports makeup days and fails closed outside its year',()=>{
  const calendar={year:2026,closures:[['10-01','10-07']],makeup_workdays:['10-10']};
  assert.equal(previousTimingQuoteDay('2026-10-12',calendar),'2026-10-10');
  assert.equal(previousTimingQuoteDay('2026-10-08',calendar),'2026-09-30');
  assert.throws(()=>previousTimingQuoteDay('2027-01-04',calendar),/Unverified/);
});
